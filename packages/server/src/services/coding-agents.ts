import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, realpathSync } from 'fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import { promisify } from 'util'
import { getWebUiHome } from '../config'
import { PROVIDER_ENV_MAP, readConfigYamlForProfile, safeReadFile } from './config-helpers'
import { getCompatibleCustomProviders } from './hermes/custom-providers-compat'
import { registerClaudeCodeProxyTarget } from './agent-runner/proxies/claude-code-proxy'
import { registerCodexProxyTarget } from './agent-runner/proxies/codex-proxy'
import type { ApiMode } from './agent-runner/types'
import { PROVIDER_PRESETS } from '../shared/providers'
import { getModelContextLength } from './hermes/model-context'
import { getProfileDir } from './hermes/hermes-profile'
import { getSystemPrompt } from '../lib/llm-prompt'
import { codingAgentRunManager } from './agent-runner/coding-agent-run-manager'
import { getSession, updateSession, type HermesSessionRow } from '../db/hermes/session-store'
import type { SessionState } from './hermes/run-chat/types'
import { normalizeWindowsCommandPath, windowsCmdShimExecution, windowsCommandNeedsShell, type WindowsCommandExecution } from './windows-command'

const execFileAsync = promisify(execFile)
const LAUNCH_API_MODES = new Set<ApiMode>(['chat_completions', 'codex_responses', 'anthropic_messages'])
const CODING_AGENT_HOME_DIR = 'coding-agent'
const CODEX_MODEL_CATALOG_FILE = 'codex-model-catalog.json'
const CODEX_CATALOG_BASE_INSTRUCTIONS = 'You are Codex, a coding agent. Be precise, safe, and helpful.'
const NODE_ENVIRONMENT_MISSING_CODE = 'node_environment_missing'
const POSIX_LAUNCHER_FILE = 'launch.sh'
const WINDOWS_LAUNCHER_FILE = 'launch.ps1'
const CODING_AGENT_SCOPED_AUTH_PROVIDERS = new Set(['openai-codex', 'copilot', 'xai-oauth', 'nous', 'google-gemini-cli', 'claude-oauth'])
const CLAUDE_CODE_SKIP_PERMISSIONS_ARGS = ['--dangerously-skip-permissions']
const CLAUDE_CODE_ROOT_PERMISSION_ARGS = ['--permission-mode', 'auto']
const HERMES_MCP_SERVER_NAME = 'hermes-studio'
const HERMES_MCP_MANAGED_ENV_KEY = 'HERMES_WEB_UI_MANAGED_MCP'
const HERMES_PROMPT_BLOCK_BEGIN = '<!-- BEGIN HERMES WEB UI PROMPT -->'
const HERMES_PROMPT_BLOCK_END = '<!-- END HERMES WEB UI PROMPT -->'

interface CommandExecution {
  command: string
  args: string[]
  windowsVerbatimArguments?: WindowsCommandExecution['windowsVerbatimArguments']
}

export type CodingAgentId = 'claude-code' | 'codex'

export interface CodingAgentDefinition {
  id: CodingAgentId
  name: string
  provider: string
  command: string
  packageName: string
}

export interface CodingAgentToolStatus extends CodingAgentDefinition {
  installed: boolean
  version: string
  rawVersion: string
  error?: string
}

export interface CodingAgentsStatus {
  tools: CodingAgentToolStatus[]
}

export interface CodingAgentMutationResult extends CodingAgentsStatus {
  success: boolean
  tool: CodingAgentToolStatus
  message?: string
  code?: string
}

export interface CodingAgentConfigFileDefinition {
  key: string
  path: string
  absolutePath: string
  language: string
}

export interface CodingAgentConfigScope {
  profile?: string
  provider?: string
}

export interface CodingAgentConfigFileContent extends CodingAgentConfigFileDefinition {
  content: string
  exists: boolean
  size: number
  profile: string
  provider: string
  rootDir: string
}

export interface CodingAgentLaunchInput extends CodingAgentConfigScope {
  mode?: 'scoped' | 'global'
  model?: string
  workspace?: string | null
  baseUrl?: string
  apiKey?: string
  apiMode?: ApiMode
  sessionId?: string
  agentSessionId?: string
  agentNativeSessionId?: string
  isolateSettings?: boolean
  sessionSource?: 'global_agent'
}

export interface CodingAgentLaunchResult {
  agentId: CodingAgentId
  mode: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  rootDir: string
  workspaceDir: string
  command: string
  args: string[]
  env: Record<string, string>
  shellCommand: string
  files: Array<{ key: string; path: string; absolutePath: string }>
}

export interface CodingAgentNativeLaunchResult extends CodingAgentLaunchResult {
  nativeTerminal: true
  terminal: string
}

export interface CodingAgentRunStartResult extends CodingAgentLaunchResult {
  agentSessionId: string
  sessionId: string
  pid: number
}

const TOOL_DEFINITIONS: CodingAgentDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    provider: 'Anthropic',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    command: 'codex',
    packageName: '@openai/codex',
  },
]

const CONFIG_FILE_DEFINITIONS: Record<CodingAgentId, Array<Omit<CodingAgentConfigFileDefinition, 'absolutePath'> & { scopedPath: string }>> = {
  'claude-code': [
    { key: 'settings', path: '~/.claude/settings.json', scopedPath: 'settings.json', language: 'json' },
    { key: 'mcp', path: '~/.claude.json', scopedPath: 'mcp.json', language: 'json' },
    { key: 'prompt', path: '~/.claude/CLAUDE.md', scopedPath: 'CLAUDE.md', language: 'markdown' },
  ],
  codex: [
    { key: 'auth', path: '~/.codex/auth.json', scopedPath: 'auth.json', language: 'json' },
    { key: 'config', path: '~/.codex/config.toml', scopedPath: 'config.toml', language: 'ini' },
    { key: 'agents', path: '~/.codex/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
  ],
}

const installingTools = new Set<CodingAgentId>()
const deletingTools = new Set<CodingAgentId>()
let cachedGlobalNpmBin: string | null | undefined
let cachedLoginShellPath: string | null | undefined
const MAX_CONFIG_FILE_SIZE = parseInt(process.env.MAX_EDIT_SIZE || '', 10) || 10 * 1024 * 1024

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNodePrefix() {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getHomebrewPrefix() {
  const match = process.execPath.match(/^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/node$/)
  return match?.[1] || null
}

function getNpmCliCandidates() {
  const prefix = getNodePrefix()
  const homebrewPrefix = getHomebrewPrefix()

  return process.platform === 'win32'
    ? [
        join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(getNodeBinDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
        join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ...(homebrewPrefix ? [join(homebrewPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] : []),
      ]
}

function getNpmCliPath() {
  return getNpmCliCandidates().find(existsSync) || null
}

function getNpmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function getGlobalConfigHome() {
  return process.env.HERMES_CODING_AGENT_GLOBAL_HOME?.trim() || homedir()
}

function compareNodeVersionDesc(left: string, right: string): number {
  const leftParts = left.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const rightParts = right.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (rightParts[index] || 0) - (leftParts[index] || 0)
    if (diff !== 0) return diff
  }
  return right.localeCompare(left)
}

function getNvmNodeBinPaths(): string {
  if (process.env.HERMES_DESKTOP !== 'true' || process.platform === 'win32') return ''

  const nvmDir = process.env.NVM_DIR?.trim() || join(homedir(), '.nvm')
  const versionsDir = join(nvmDir, 'versions', 'node')
  if (!existsSync(versionsDir)) return ''

  try {
    return readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort(compareNodeVersionDesc)
      .map(version => join(versionsDir, version, 'bin'))
      .filter(binDir => existsSync(binDir))
      .join(delimiter)
  } catch {
    return ''
  }
}

function getLoginShellCandidates(): string[] {
  if (process.platform === 'win32') return []
  return [
    process.env.SHELL || '',
    '/bin/zsh',
    '/bin/bash',
    '/usr/bin/zsh',
    '/usr/bin/bash',
  ].filter(Boolean)
}

function getLoginShell(): string | null {
  for (const shell of [...new Set(getLoginShellCandidates())]) {
    if (shell.startsWith('/') && existsSync(shell)) return shell
  }
  return null
}

async function getLoginShellPath(): Promise<string | null> {
  if (process.env.HERMES_DESKTOP !== 'true' || process.platform === 'win32') return null
  if (typeof cachedLoginShellPath !== 'undefined') return cachedLoginShellPath

  const shell = getLoginShell()
  if (!shell) {
    cachedLoginShellPath = null
    return cachedLoginShellPath
  }

  try {
    const { stdout } = await execFileAsync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    })
    cachedLoginShellPath = stdout.trim() || null
  } catch {
    cachedLoginShellPath = null
  }
  return cachedLoginShellPath
}

function getDesktopCommonBinPaths(): string[] {
  if (process.env.HERMES_DESKTOP !== 'true' || process.platform === 'win32') return []
  const home = homedir()
  return [
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
    join(home, '.pnpm'),
    join(home, 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
}

function prependPathEntries(env: NodeJS.ProcessEnv, entries: Array<string | null | undefined>) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const currentPath = env[pathKey] || ''
  const existing = new Set(currentPath.split(delimiter).filter(Boolean))
  const prepended: string[] = []

  for (const entry of entries) {
    if (!entry) continue
    for (const segment of entry.split(delimiter).map(item => item.trim()).filter(Boolean)) {
      if (existing.has(segment) || prepended.includes(segment)) continue
      prepended.push(segment)
    }
  }

  if (prepended.length > 0) {
    env[pathKey] = currentPath ? `${prepended.join(delimiter)}${delimiter}${currentPath}` : prepended.join(delimiter)
  }
}

function nodeEnvironmentMissingError(): Error {
  const err = new Error('Node/npm environment was not detected. Please install Node.js and try again.')
  ;(err as any).code = NODE_ENVIRONMENT_MISSING_CODE
  return err
}

function isNodeEnvironmentMissingError(err: any): boolean {
  const text = [
    err?.code,
    err?.message,
    typeof err?.stderr === 'string' ? err.stderr : '',
    typeof err?.stdout === 'string' ? err.stdout : '',
  ].filter(Boolean).join('\n').toLowerCase()
  return text.includes('enoent') ||
    text.includes('spawn npm') ||
    text.includes('npm: command not found') ||
    text.includes('npm not found') ||
    text.includes('node: command not found') ||
    text.includes('node not found')
}

function npmCliFromNpmBin(npmBin: string): { node: string; npmCli: string } | null {
  const binDir = dirname(npmBin)
  if (process.platform === 'win32') {
    const node = join(binDir, 'node.exe')
    const npmCli = join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return existsSync(node) && existsSync(npmCli) ? { node, npmCli } : null
  }

  const node = join(binDir, 'node')
  const npmCli = join(dirname(binDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(node) && existsSync(npmCli) ? { node, npmCli } : null
}

function normalizeScopeSegment(value: string | undefined, fallback: string, label: string): string {
  // Replace invalid filename characters with underscores
  // Windows invalid chars: < > : " / \ | ? *
  // Additional problematic chars: control characters
  const sanitizedValue = String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  const segment = sanitizedValue || fallback

  if (
    segment === '.' ||
    segment === '..' ||
    segment.includes('\0')
  ) {
    const err = new Error(`Invalid ${label}`)
    ;(err as any).status = 400
    throw err
  }
  if (segment.length > 128) {
    const err = new Error(`${label} is too long`)
    ;(err as any).status = 400
    throw err
  }
  return segment
}

function normalizeConfigScope(scope: CodingAgentConfigScope = {}): Required<CodingAgentConfigScope> {
  return {
    profile: normalizeScopeSegment(scope.profile, 'default', 'profile'),
    provider: normalizeScopeSegment(scope.provider, 'default', 'provider'),
  }
}

function slugProviderName(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/ /g, '-')
}

function providerKeyWithoutCustomPrefix(providerKey: string): string {
  if (providerKey.startsWith('custom:')) return providerKey.slice('custom:'.length)
  if (providerKey.startsWith('custom_')) return providerKey.slice('custom_'.length)
  return providerKey
}

function providerLookupCandidates(provider: string): string[] {
  const trimmed = String(provider || '').trim()
  const withoutCustom = providerKeyWithoutCustomPrefix(trimmed)
  return [...new Set([
    trimmed,
    withoutCustom,
    withoutCustom ? `custom:${withoutCustom}` : '',
    withoutCustom ? `custom_${withoutCustom}` : '',
  ].filter(Boolean))]
}

function parseEnvValue(envContent: string, key: string): string {
  if (!key) return ''
  const lines = envContent.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    if (trimmed.slice(0, eqIndex).trim() !== key) continue
    const raw = trimmed.slice(eqIndex + 1).trim()
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1)
    }
    return raw
  }
  return ''
}

function inferLaunchApiMode(provider: string, baseUrl: string, fallback: ApiMode = 'chat_completions'): ApiMode {
  const providerKey = String(provider || '').toLowerCase()
  const normalizedBaseUrl = String(baseUrl || '').toLowerCase()
  if (
    providerKey.includes('claude') ||
    providerKey === 'anthropic' ||
    normalizedBaseUrl.includes('anthropic') ||
    normalizedBaseUrl.includes('/anthropic')
  ) {
    return 'anthropic_messages'
  }
  if (
    providerKey === 'deepseek' ||
    providerKey === 'lmstudio' ||
    normalizedBaseUrl.includes('deepseek') ||
    normalizedBaseUrl.includes('127.0.0.1') ||
    normalizedBaseUrl.includes('localhost')
  ) {
    return 'chat_completions'
  }
  return fallback
}

function isScopedCodingAgentAuthProvider(provider: string, apiKey = ''): boolean {
  const providerKey = String(provider || '').trim().toLowerCase()
  return CODING_AGENT_SCOPED_AUTH_PROVIDERS.has(providerKey)
}

function assertScopedCodingAgentProviderAllowed(mode: CodingAgentLaunchResult['mode'], provider: string, apiKey = ''): void {
  if (mode === 'global') return
  if (!isScopedCodingAgentAuthProvider(provider, apiKey)) return
  const err = new Error('Coding agent scoped mode does not support OAuth/subscription providers. Use global mode or select an API-key provider.')
  ;(err as any).status = 400
  throw err
}

async function resolveStoredProviderLaunchInput(
  input: CodingAgentLaunchInput & { sessionId: string },
  existingSession: HermesSessionRow | null,
): Promise<CodingAgentLaunchInput & { sessionId: string }> {
  if (input.mode === 'global') return input

  const profile = String(input.profile || existingSession?.profile || 'default').trim() || 'default'
  const provider = String(input.provider || existingSession?.provider || '').trim()
  const model = String(input.model || existingSession?.model || '').trim()
  let baseUrl = String(input.baseUrl || '').trim()
  let apiKey = String(input.apiKey || '').trim()
  let apiMode = input.apiMode
  let canonicalProvider = provider

  if (!provider || (baseUrl && apiKey && apiMode)) {
    return { ...input, profile, provider: provider || input.provider, model: model || input.model, baseUrl, apiKey, apiMode }
  }

  let config: Record<string, any> = {}
  try {
    config = await readConfigYamlForProfile(profile)
  } catch {}
  const envContent = await safeReadFile(join(getProfileDir(profile), '.env')) || ''
  const normalizedProvider = providerKeyWithoutCustomPrefix(provider)
  const preset = PROVIDER_PRESETS.find(item => item.value === normalizedProvider)
  const candidates = providerLookupCandidates(provider)

  const customProviders = getCompatibleCustomProviders(config)
  const customEntry = customProviders.find((entry) => {
    const name = slugProviderName(String(entry?.name || ''))
    return candidates.includes(`custom:${name}`) || candidates.includes(`custom_${name}`) || candidates.includes(name)
  })
  if (customEntry) {
    canonicalProvider = `custom:${slugProviderName(String(customEntry.name || normalizedProvider))}`
    if (!baseUrl) baseUrl = String(customEntry.base_url || '').trim()
    if (!apiKey) apiKey = String(customEntry.api_key || '').trim()
    if (!apiMode) {
      apiMode = normalizeLaunchApiMode(
        customEntry.api_mode,
        preset?.api_mode || inferLaunchApiMode(canonicalProvider, baseUrl, 'chat_completions'),
      )
    }
  }

  const canonicalProviderKey = providerKeyWithoutCustomPrefix(canonicalProvider)
  const canonicalPreset = PROVIDER_PRESETS.find(item => item.value === canonicalProviderKey) || preset
  const envMapping = PROVIDER_ENV_MAP[canonicalProviderKey]
  if (!baseUrl) {
    baseUrl = envMapping?.base_url_env
      ? parseEnvValue(envContent, envMapping.base_url_env) || canonicalPreset?.base_url || ''
      : canonicalPreset?.base_url || ''
  }
  if (!apiKey && envMapping?.api_key_env) {
    apiKey = parseEnvValue(envContent, envMapping.api_key_env)
  }
  if (!apiMode) {
    apiMode = normalizeLaunchApiMode(
      canonicalPreset?.api_mode,
      inferLaunchApiMode(canonicalProvider, baseUrl, 'chat_completions'),
    )
  }

  return {
    ...input,
    profile,
    provider: canonicalProvider,
    model: model || input.model,
    baseUrl: baseUrl || input.baseUrl,
    apiKey: apiKey || input.apiKey,
    apiMode,
  }
}

function normalizeLaunchApiMode(value: unknown, fallback: ApiMode): ApiMode {
  if (!value) return fallback
  const mode = String(value).trim() as ApiMode
  if (!LAUNCH_API_MODES.has(mode)) {
    const err = new Error('Invalid API protocol')
    ;(err as any).status = 400
    throw err
  }
  return mode
}

function storedCodingAgentMode(session: HermesSessionRow | null): 'scoped' | 'global' {
  if (session?.agent_mode === 'global' || session?.agent_mode === 'scoped') return session.agent_mode
  return session?.provider === 'global' ? 'global' : 'scoped'
}

function makeAgentSessionId(): string {
  return `coding_agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function getScopedConfigRoot(id: CodingAgentId, scope: Required<CodingAgentConfigScope>): string {
  return join(getWebUiHome(), CODING_AGENT_HOME_DIR, 'model', scope.profile, scope.provider, id)
}

function getScopedWorkspaceRoot(scope: Required<CodingAgentConfigScope>): string {
  return join(getWebUiHome(), CODING_AGENT_HOME_DIR, 'workspace', scope.profile, scope.provider)
}

function resolveLaunchWorkspaceRoot(scope: Required<CodingAgentConfigScope>, workspace?: string | null): string {
  const customWorkspace = String(workspace || '').trim()
  if (customWorkspace) {
    if (customWorkspace.includes('\0')) {
      const err = new Error('Invalid workspace')
      ;(err as any).status = 400
      throw err
    }
    return customWorkspace
  }
  return getScopedWorkspaceRoot(scope)
}

function displayNameForModel(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return 'Model'
  const leaf = trimmed.split('/').filter(Boolean).pop() || trimmed
  return leaf
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

function codexCatalogEntry(input: {
  model: string
  displayName: string
  contextWindow: number
  priority: number
}) {
  return {
    slug: input.model,
    display_name: input.displayName,
    description: input.displayName,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1000 + input.priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: CODEX_CATALOG_BASE_INSTRUCTIONS,
    model_messages: {
      instructions_template: '{{ base_instructions }}\n\n{{ personality }}',
      instructions_variables: {
        base_instructions: CODEX_CATALOG_BASE_INSTRUCTIONS,
        personality: '',
        personality_default: '',
        personality_friendly: '',
        personality_pragmatic: '',
      },
    },
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'auto',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: input.contextWindow,
    max_context_window: input.contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: true,
  }
}

function buildCodexModelCatalog(input: {
  profile: string
  provider: string
  model: string
  presetModels: string[]
}) {
  const models = [...new Set([input.model, ...input.presetModels].map(item => item.trim()).filter(Boolean))]
  return {
    models: models.map((model, index) => codexCatalogEntry({
      model,
      displayName: displayNameForModel(model),
      contextWindow: getModelContextLength({ profile: input.profile, provider: input.provider, model }),
      priority: index,
    })),
  }
}

function hasRootPrivileges(): boolean {
  if (process.platform === 'win32') return false
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : null
  return uid === 0 || euid === 0
}

function claudeCodePermissionArgs(): string[] {
  return hasRootPrivileges() ? CLAUDE_CODE_ROOT_PERMISSION_ARGS : CLAUDE_CODE_SKIP_PERMISSIONS_ARGS
}

function expandHomePath(path: string): string {
  if (path === '~') return getGlobalConfigHome()
  if (path.startsWith('~/')) return join(getGlobalConfigHome(), path.slice(2))
  return path
}

function hermesPromptDocument(): string {
  return [
    HERMES_PROMPT_BLOCK_BEGIN,
    getSystemPrompt().trim(),
    HERMES_PROMPT_BLOCK_END,
    '',
  ].join('\n')
}

function upsertManagedMarkdownBlock(existing: string, block: string): string {
  const normalizedBlock = block.endsWith('\n') ? block : `${block}\n`
  const start = existing.indexOf(HERMES_PROMPT_BLOCK_BEGIN)
  const end = existing.indexOf(HERMES_PROMPT_BLOCK_END)
  if (start >= 0 && end >= start) {
    const afterEnd = end + HERMES_PROMPT_BLOCK_END.length
    const before = existing.slice(0, start).replace(/\s*$/, '')
    const after = existing.slice(afterEnd).replace(/^\s*/, '')
    return [before, normalizedBlock.trimEnd(), after].filter(Boolean).join('\n\n') + '\n'
  }
  const trimmedExisting = existing.replace(/\s*$/, '')
  if (!trimmedExisting) return normalizedBlock
  return `${trimmedExisting}\n\n${normalizedBlock}`
}

async function writeManagedPromptFile(definition: CodingAgentConfigFileDefinition): Promise<{ key: string; path: string; absolutePath: string }> {
  let existing = ''
  try {
    existing = await readFile(definition.absolutePath, 'utf-8')
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }
  const next = upsertManagedMarkdownBlock(existing, hermesPromptDocument())
  if (next !== existing) {
    await mkdir(dirname(definition.absolutePath), { recursive: true })
    await writeFile(definition.absolutePath, next, 'utf-8')
  }
  return {
    key: definition.key,
    path: definition.path,
    absolutePath: definition.absolutePath,
  }
}

async function ensureGlobalCodingAgentPromptFile(id: CodingAgentId): Promise<Array<{ key: string; path: string; absolutePath: string }>> {
  if (id !== 'claude-code') return []
  const definition = getLiveConfigFileDefinition(id, 'prompt')
  if (!definition) return []
  return [await writeManagedPromptFile(definition)]
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

function tomlInlineStringTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`
}

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function candidateBundledMcpScripts(): string[] {
  return [
    process.env.HERMES_WEB_UI_MCP_BIN,
    join(process.cwd(), 'bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../../../../bin/hermes-web-ui-mcp.mjs'),
  ].filter((value): value is string => !!value)
}

function bundledMcpScriptPath(): string | null {
  return candidateBundledMcpScripts().find(candidate => existsSync(candidate)) || null
}

function hermesMcpCommandConfig(): { command: string; args?: string[] } {
  if (isDesktopRuntime()) return { command: 'hermes-studio-mcp' }
  const script = bundledMcpScriptPath()
  if (script) return { command: process.execPath, args: [script] }
  return { command: 'hermes-web-ui-mcp' }
}

function hermesMcpServerConfig(profile: string): { command: string; args?: string[]; env: Record<string, string> } {
  const appHome = getWebUiHome()
  return {
    ...hermesMcpCommandConfig(),
    env: {
      HERMES_WEB_UI_URL: `http://127.0.0.1:${process.env.PORT || '8648'}`,
      HERMES_WEB_UI_HOME: appHome,
      HERMES_WEBUI_STATE_DIR: appHome,
      HERMES_WEB_UI_PROFILE: profile,
      HERMES_MCP_SERVER_NAME: 'hermes-studio-mcp',
      [HERMES_MCP_MANAGED_ENV_KEY]: '1',
    },
  }
}

function claudeMcpConfigJson(profile: string): string {
  return `${JSON.stringify({ mcpServers: { [HERMES_MCP_SERVER_NAME]: hermesMcpServerConfig(profile) } }, null, 2)}\n`
}

function codexMcpConfigToml(profile: string): string {
  const server = hermesMcpServerConfig(profile)
  const lines = [
    `[mcp_servers.${HERMES_MCP_SERVER_NAME}]`,
    `command = ${tomlString(server.command)}`,
  ]
  if (server.args?.length) lines.push(`args = ${tomlStringArray(server.args)}`)
  lines.push('startup_timeout_sec = 120')
  lines.push(`env = ${tomlInlineStringTable(server.env)}`)
  lines.push('')
  return lines.join('\n')
}

function buildLaunchShellCommand(input: {
  workspaceDir: string
  env: Record<string, string>
  command: string
  args: string[]
}): string {
  if (process.platform === 'win32') {
    const envAssignments = Object.entries(input.env)
      .map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`)
    return [
      `Set-Location -LiteralPath ${powerShellQuote(input.workspaceDir)}`,
      ...envAssignments,
      `& ${powerShellQuote(input.command)} ${input.args.map(powerShellQuote).join(' ')}`.trim(),
    ].join('; ')
  }

  const envPrefix = Object.entries(input.env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')
  const runCommand = [
    envPrefix,
    shellQuote(input.command),
    ...input.args.map(shellQuote),
  ].filter(Boolean).join(' ')
  return `cd ${shellQuote(input.workspaceDir)} && ${runCommand}`
}

function buildPosixLauncherScript(input: {
  workspaceDir: string
  env: Record<string, string>
  command: string
  args: string[]
}): string {
  const exports = Object.entries(input.env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
  const command = [
    shellQuote(input.command),
    ...input.args.map(shellQuote),
  ].join(' ')
  return [
    '#!/usr/bin/env bash',
    'set -e',
    `cd ${shellQuote(input.workspaceDir)}`,
    ...exports,
    `exec ${command}`,
    '',
  ].join('\n')
}

function buildPowerShellLauncherScript(input: {
  workspaceDir: string
  env: Record<string, string>
  command: string
  args: string[]
}): string {
  const envAssignments = Object.entries(input.env)
    .map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`)
  const command = [
    `& ${powerShellQuote(input.command)}`,
    ...input.args.map(powerShellQuote),
  ].join(' ')
  return [
    '$ErrorActionPreference = "Stop"',
    `Set-Location -LiteralPath ${powerShellQuote(input.workspaceDir)}`,
    ...envAssignments,
    command,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')
}

async function writeLauncherScript(input: {
  rootDir: string
  workspaceDir: string
  env: Record<string, string>
  command: string
  args: string[]
}): Promise<string> {
  const isWindows = process.platform === 'win32'
  const launcherPath = join(input.rootDir, isWindows ? WINDOWS_LAUNCHER_FILE : POSIX_LAUNCHER_FILE)
  await writeFile(
    launcherPath,
    isWindows ? buildPowerShellLauncherScript(input) : buildPosixLauncherScript(input),
    'utf-8',
  )
  if (!isWindows) await chmod(launcherPath, 0o700)
  return launcherPath
}

function buildLauncherShellCommand(workspaceDir: string, launcherPath: string): string {
  return process.platform === 'win32'
    ? buildLaunchShellCommand({
        workspaceDir,
        env: {},
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath],
      })
    : buildLaunchShellCommand({
        workspaceDir,
        env: {},
        command: launcherPath,
        args: [],
      })
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

function isDockerRuntime(): boolean {
  return existsSync('/.dockerenv') || process.env.container === 'docker'
}

async function openNativeTerminal(shellCommand: string): Promise<string> {
  if (process.platform === 'win32') {
    const escapedCommand = shellCommand.replace(/"/g, '""').replace(/\$/g, '`$')
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath powershell.exe -ArgumentList @('-NoExit', '-Command', "${escapedCommand}")`,
    ], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    })
    return 'PowerShell'
  }

  if (process.platform === 'darwin') {
    await execFileAsync('osascript', [
      '-e',
      `tell application "Terminal" to do script ${appleScriptString(shellCommand)}`,
      '-e',
      'tell application "Terminal" to activate',
    ], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    })
    return 'Terminal.app'
  }

  if (process.platform === 'linux') {
    if (isDockerRuntime()) {
      const err = new Error('Native terminal is not available inside Docker')
      ;(err as any).status = 400
      throw err
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      const err = new Error('Native terminal requires a Linux desktop session')
      ;(err as any).status = 400
      throw err
    }

    const candidates: Array<{ command: string; args: string[] }> = [
      { command: 'xdg-terminal-exec', args: ['bash', '-lc', shellCommand] },
      { command: 'gnome-terminal', args: ['--', 'bash', '-lc', shellCommand] },
      { command: 'konsole', args: ['-e', 'bash', '-lc', shellCommand] },
      { command: 'xfce4-terminal', args: ['--command', `bash -lc ${shellQuote(shellCommand)}`] },
      { command: 'kitty', args: ['bash', '-lc', shellCommand] },
      { command: 'alacritty', args: ['-e', 'bash', '-lc', shellCommand] },
      { command: 'xterm', args: ['-e', 'bash', '-lc', shellCommand] },
    ]

    const errors: string[] = []
    for (const candidate of candidates) {
      if (!(await commandExists(candidate.command))) continue
      try {
        await execFileAsync(candidate.command, candidate.args, {
          encoding: 'utf-8',
          timeout: 8000,
          windowsHide: true,
        })
        return candidate.command
      } catch (err: any) {
        errors.push(`${candidate.command}: ${normalizeError(err)}`)
      }
    }

    const err = new Error(errors[0] || 'No supported Linux terminal command was found')
    ;(err as any).status = 400
    throw err
  }

  const err = new Error('Native terminal launch is not supported on this platform')
  ;(err as any).status = 400
  throw err
}

function getLiveConfigFileDefinition(id: string, key: string): CodingAgentConfigFileDefinition | null {
  const tool = getCodingAgentDefinition(id)
  if (!tool) return null
  const definition = CONFIG_FILE_DEFINITIONS[tool.id].find(file => file.key === key)
  if (!definition) return null
  return {
    key: definition.key,
    path: definition.path,
    language: definition.language,
    absolutePath: expandHomePath(definition.path),
  }
}

function getScopedConfigFileDefinition(id: string, key: string, scopeInput: CodingAgentConfigScope = {}): (CodingAgentConfigFileDefinition & Required<CodingAgentConfigScope> & { rootDir: string }) | null {
  const tool = getCodingAgentDefinition(id)
  if (!tool) return null
  const definition = CONFIG_FILE_DEFINITIONS[tool.id].find(file => file.key === key)
  if (!definition) return null
  const scope = normalizeConfigScope(scopeInput)
  const rootDir = getScopedConfigRoot(tool.id, scope)
  return {
    key: definition.key,
    path: definition.path,
    language: definition.language,
    ...scope,
    rootDir,
    absolutePath: join(rootDir, definition.scopedPath),
  }
}

function getCurrentNodeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [getNodeBinDir(), getNvmNodeBinPaths(), process.env.PATH].filter(Boolean).join(delimiter),
    npm_node_execpath: process.execPath,
  }
}

async function npmExecution(args: string[], env: NodeJS.ProcessEnv): Promise<CommandExecution> {
  const bundledNpmCli = getNpmCliPath()
  if (bundledNpmCli) return { command: process.execPath, args: [bundledNpmCli, ...args] }

  let npmBin: string | null = null
  for (const command of [...new Set([getNpmBin(), 'npm'])]) {
    const paths = await findCommandPaths(command, env)
    if (paths[0]) {
      npmBin = paths[0]
      break
    }
  }
  if (!npmBin) throw nodeEnvironmentMissingError()

  const npmCli = npmCliFromNpmBin(npmBin)
  if (npmCli) return { command: npmCli.node, args: [npmCli.npmCli, ...args] }

  let nodeBin: string | null = null
  for (const command of [...new Set([process.platform === 'win32' ? 'node.exe' : 'node', 'node'])]) {
    const paths = await findCommandPaths(command, env)
    if (paths[0]) {
      nodeBin = paths[0]
      break
    }
  }
  if (!nodeBin) throw nodeEnvironmentMissingError()

  return commandExecution(npmBin, args)
}

async function runNpm(args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const env = {
    ...getCurrentNodeEnv(),
    ...options.env,
  }
  const execution = await npmExecution(args, env)
  return execFileAsync(execution.command, execution.args, {
    encoding: 'utf-8',
    timeout: options.timeout,
    windowsHide: true,
    windowsVerbatimArguments: execution.windowsVerbatimArguments,
    maxBuffer: 10 * 1024 * 1024,
    env,
  })
}

function normalizeError(err: any): string {
  if (isNodeEnvironmentMissingError(err)) return nodeEnvironmentMissingError().message
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
  const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : ''
  const message = stderr || stdout || err?.message || String(err)
  return message.split(/\r?\n/).filter(Boolean).slice(0, 4).join('\n')
}

function normalizeErrorCode(err: any): string | undefined {
  return isNodeEnvironmentMissingError(err) ? NODE_ENVIRONMENT_MISSING_CODE : undefined
}

async function findCommandPaths(command: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    const lookupArgs = process.platform === 'win32' ? [command] : ['-a', command]
    const { stdout } = await execFileAsync(lookupCommand, lookupArgs, {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      env,
    })
    return stdout.split(/\r?\n/).map(line => normalizeWindowsCommandPath(line.trim())).filter(Boolean)
  } catch {
    return []
  }
}

async function resolveCommandForExecution(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== 'win32') return command
  const paths = await findCommandPaths(command, env)
  // On Windows, prioritize paths with .cmd or .bat extensions since where may return
  // both the unix-style script (without extension) and the Windows shim (.cmd)
  const windowsPath = paths.find(path => windowsCommandNeedsShell(path))
  return windowsPath || paths[0] || command
}

function commandExecution(command: string, args: string[]): CommandExecution {
  const normalizedCommand = normalizeWindowsCommandPath(command)
  if (process.platform === 'win32' && windowsCommandNeedsShell(normalizedCommand)) {
    return windowsCmdShimExecution(normalizedCommand, args)
  }
  return { command: normalizedCommand, args }
}

function packageParts(packageName: string): string[] {
  return packageName.split('/').filter(Boolean)
}

function getPrefixFromPackagePath(path: string, packageName: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  const packageNameParts = packageParts(packageName)

  if (nodeModulesIndex <= 0) return null
  for (let i = 0; i < packageNameParts.length; i += 1) {
    if (parts[nodeModulesIndex + 1 + i] !== packageNameParts[i]) return null
  }

  const libIndex = nodeModulesIndex - 1
  if (parts[libIndex] !== 'lib') return null
  const prefixParts = parts.slice(0, libIndex)
  if (prefixParts.length === 0) return process.platform === 'win32' ? null : '/'
  return `${normalized.startsWith('/') ? '/' : ''}${prefixParts.join('/')}`
}

async function getCommandPackagePrefixes(definition: CodingAgentDefinition, env: NodeJS.ProcessEnv): Promise<string[]> {
  const commandPaths = await findCommandPaths(definition.command, env)
  const prefixes = new Set<string>()

  for (const commandPath of commandPaths) {
    const candidates = [commandPath]
    try {
      candidates.push(realpathSync(commandPath))
    } catch {
      // Keep the unresolved command path as the fallback candidate.
    }

    for (const candidate of candidates) {
      const prefix = getPrefixFromPackagePath(candidate, definition.packageName)
      if (prefix) prefixes.add(prefix)
    }
  }
  return [...prefixes]
}

function extractVersion(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] || trimmed.split(/\s+/)[0] || ''
}

async function getGlobalNpmBin(): Promise<string | null> {
  if (typeof cachedGlobalNpmBin !== 'undefined') return cachedGlobalNpmBin
  try {
    const { stdout } = await runNpm(['prefix', '-g'], { timeout: 5000 })
    const prefix = stdout.trim()
    cachedGlobalNpmBin = prefix ? (process.platform === 'win32' ? prefix : join(prefix, 'bin')) : null
  } catch {
    cachedGlobalNpmBin = null
  }
  return cachedGlobalNpmBin
}

async function commandEnv(): Promise<NodeJS.ProcessEnv> {
  const env = getCurrentNodeEnv()
  const npmBin = await getGlobalNpmBin()
  const loginShellPath = await getLoginShellPath()
  prependPathEntries(env, [
    npmBin,
    loginShellPath,
    ...getDesktopCommonBinPaths(),
  ])
  return env
}

export function getCodingAgentDefinitions(): CodingAgentDefinition[] {
  return TOOL_DEFINITIONS.map(tool => ({ ...tool }))
}

export function getCodingAgentDefinition(id: string): CodingAgentDefinition | null {
  return TOOL_DEFINITIONS.find(tool => tool.id === id) || null
}

export function getCodingAgentConfigFileDefinitions(id: string): CodingAgentConfigFileDefinition[] {
  const tool = getCodingAgentDefinition(id)
  if (!tool) return []
  return CONFIG_FILE_DEFINITIONS[tool.id].map(file => ({
    key: file.key,
    path: file.path,
    language: file.language,
    absolutePath: expandHomePath(file.path),
  }))
}

export async function getCodingAgentStatus(definition: CodingAgentDefinition): Promise<CodingAgentToolStatus> {
  try {
    const env = await commandEnv()
    const resolvedCommand = await resolveCommandForExecution(definition.command, env)
    const execution = commandExecution(resolvedCommand, ['--version'])
    const { stdout, stderr } = await execFileAsync(execution.command, execution.args, {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
      windowsVerbatimArguments: execution.windowsVerbatimArguments,
      env,
    })
    const rawVersion = `${stdout || ''}${stderr || ''}`.trim()
    return {
      ...definition,
      installed: true,
      version: extractVersion(rawVersion),
      rawVersion,
    }
  } catch (err: any) {
    return {
      ...definition,
      installed: false,
      version: '',
      rawVersion: '',
      error: normalizeError(err),
    }
  }
}

export async function getCodingAgentsStatus(): Promise<CodingAgentsStatus> {
  return {
    tools: await Promise.all(TOOL_DEFINITIONS.map(tool => getCodingAgentStatus(tool))),
  }
}

export async function installCodingAgent(id: string): Promise<CodingAgentMutationResult> {
  const tool = getCodingAgentDefinition(id)
  if (!tool) {
    const err = new Error('Unknown coding agent')
    ;(err as any).status = 400
    throw err
  }
  if (installingTools.has(tool.id)) {
    const err = new Error('Install is already running')
    ;(err as any).status = 409
    throw err
  }

  installingTools.add(tool.id)
  try {
    const env = await commandEnv()
    await runNpm(['install', '-g', tool.packageName], {
      timeout: 10 * 60 * 1000,
      env,
    })
    cachedGlobalNpmBin = undefined
    const status = await getCodingAgentStatus(tool)
    const allStatus = await getCodingAgentsStatus()
    return {
      success: status.installed,
      tool: status,
      tools: allStatus.tools,
      message: status.installed ? 'Installed' : status.error || 'Install completed but the command was not found',
    }
  } catch (err: any) {
    const status = await getCodingAgentStatus(tool)
    const allStatus = await getCodingAgentsStatus()
    return {
      success: false,
      tool: status,
      tools: allStatus.tools,
      message: normalizeError(err),
      code: normalizeErrorCode(err),
    }
  } finally {
    installingTools.delete(tool.id)
  }
}

export async function deleteCodingAgent(id: string): Promise<CodingAgentMutationResult> {
  const tool = getCodingAgentDefinition(id)
  if (!tool) {
    const err = new Error('Unknown coding agent')
    ;(err as any).status = 400
    throw err
  }
  if (deletingTools.has(tool.id)) {
    const err = new Error('Delete is already running')
    ;(err as any).status = 409
    throw err
  }

  deletingTools.add(tool.id)
  try {
    const env = await commandEnv()
    const packagePrefixes = await getCommandPackagePrefixes(tool, env)
    const uninstallArgsList = packagePrefixes.length > 0
      ? packagePrefixes.map(prefix => ['uninstall', '-g', '--prefix', prefix, tool.packageName])
      : [['uninstall', '-g', tool.packageName]]
    for (const uninstallArgs of uninstallArgsList) {
      await runNpm(uninstallArgs, {
        timeout: 10 * 60 * 1000,
        env,
      })
    }
    cachedGlobalNpmBin = undefined
    const status = await getCodingAgentStatus(tool)
    const allStatus = await getCodingAgentsStatus()
    return {
      success: !status.installed,
      tool: status,
      tools: allStatus.tools,
      message: !status.installed ? 'Deleted' : 'Delete completed but the command is still available',
    }
  } catch (err: any) {
    const status = await getCodingAgentStatus(tool)
    const allStatus = await getCodingAgentsStatus()
    return {
      success: false,
      tool: status,
      tools: allStatus.tools,
      message: normalizeError(err),
      code: normalizeErrorCode(err),
    }
  } finally {
    deletingTools.delete(tool.id)
  }
}

export async function readCodingAgentConfigFile(id: string, key: string, scope: CodingAgentConfigScope = {}): Promise<CodingAgentConfigFileContent> {
  const definition = getLiveConfigFileDefinition(id, key)
  if (!definition) {
    const err = new Error('Unknown coding agent config file')
    ;(err as any).status = 404
    throw err
  }
  const normalizedScope = normalizeConfigScope(scope)

  try {
    const info = await stat(definition.absolutePath)
    if (!info.isFile()) {
      const err = new Error('Config path is not a file')
      ;(err as any).status = 400
      throw err
    }
    if (info.size > MAX_CONFIG_FILE_SIZE) {
      const err = new Error('Config file is too large to edit')
      ;(err as any).status = 413
      throw err
    }
    return {
      ...definition,
      ...normalizedScope,
      rootDir: dirname(definition.absolutePath),
      content: await readFile(definition.absolutePath, 'utf-8'),
      exists: true,
      size: info.size,
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
    return {
      ...definition,
      ...normalizedScope,
      rootDir: dirname(definition.absolutePath),
      content: '',
      exists: false,
      size: 0,
    }
  }
}

export async function writeCodingAgentConfigFile(id: string, key: string, content: string, scope: CodingAgentConfigScope = {}): Promise<CodingAgentConfigFileContent> {
  const definition = getLiveConfigFileDefinition(id, key)
  if (!definition) {
    const err = new Error('Unknown coding agent config file')
    ;(err as any).status = 404
    throw err
  }
  const normalizedScope = normalizeConfigScope(scope)

  const buffer = Buffer.from(content || '', 'utf-8')
  if (buffer.length > MAX_CONFIG_FILE_SIZE) {
    const err = new Error('Config file content is too large')
    ;(err as any).status = 413
    throw err
  }

  await mkdir(dirname(definition.absolutePath), { recursive: true })
  await writeFile(definition.absolutePath, buffer)
  return {
    ...definition,
    ...normalizedScope,
    rootDir: dirname(definition.absolutePath),
    content,
    exists: true,
    size: buffer.length,
  }
}

export async function prepareCodingAgentLaunch(id: string, input: CodingAgentLaunchInput): Promise<CodingAgentLaunchResult> {
  const tool = getCodingAgentDefinition(id)
  if (!tool) {
    const err = new Error('Unknown coding agent')
    ;(err as any).status = 400
    throw err
  }

  const mode = input.mode === 'global' ? 'global' : 'scoped'
  if (mode === 'global') {
    const scope = normalizeConfigScope({ profile: input.profile, provider: 'global' })
    const workspaceDir = resolveLaunchWorkspaceRoot(scope, input.workspace)
    const args = tool.id === 'claude-code' ? claudeCodePermissionArgs() : []
    await mkdir(workspaceDir, { recursive: true })
    const files = await ensureGlobalCodingAgentPromptFile(tool.id)
    const shellCommand = buildLaunchShellCommand({
      workspaceDir,
      env: {},
      command: tool.command,
      args,
    })
    return {
      agentId: tool.id,
      mode,
      profile: scope.profile,
      provider: scope.provider,
      model: '',
      rootDir: workspaceDir,
      workspaceDir,
      command: tool.command,
      args,
      env: {},
      shellCommand,
      files,
    }
  }

  const provider = normalizeScopeSegment(input.provider, 'default', 'provider')
  const scope = normalizeConfigScope({ profile: input.profile, provider })
  const model = String(input.model || '').trim()
  const apiKey = String(input.apiKey || '').trim()
  assertScopedCodingAgentProviderAllowed(mode, provider, apiKey)
  if (!model) {
    const err = new Error('Model is required')
    ;(err as any).status = 400
    throw err
  }

  const baseUrl = String(input.baseUrl || '').trim()
  const preset = PROVIDER_PRESETS.find(item => item.value === provider)
  const apiMode = normalizeLaunchApiMode(input.apiMode, preset?.api_mode || 'chat_completions')
  const rootDir = getScopedConfigRoot(tool.id, scope)
  const workspaceDir = resolveLaunchWorkspaceRoot(scope, input.workspace)
  await mkdir(rootDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })

  const files: Array<{ key: string; path: string; absolutePath: string }> = []
  const writeScopedFile = async (key: string, content: string) => {
    const definition = getScopedConfigFileDefinition(tool.id, key, scope)
    if (!definition) return
    await mkdir(dirname(definition.absolutePath), { recursive: true })
    await writeFile(definition.absolutePath, content, 'utf-8')
    files.push({ key, path: definition.path, absolutePath: definition.absolutePath })
  }

  let args: string[] = []
  let env: Record<string, string> = {}

  if (tool.id === 'claude-code') {
    const proxyTarget = baseUrl && apiKey
      ? registerClaudeCodeProxyTarget({
          provider,
          model,
          baseUrl,
          apiKey,
          apiMode,
          agentId: tool.id,
          agentSessionId: input.agentSessionId,
          chatSessionId: input.sessionId,
        })
      : null
    const claudeBaseUrl = proxyTarget?.baseUrl || baseUrl
    const claudeApiKey = proxyTarget?.token || apiKey
    const modelName = displayNameForModel(model)
    const settings = {
      model,
      env: {
        ...(claudeApiKey ? { ANTHROPIC_API_KEY: claudeApiKey } : {}),
        ...(claudeBaseUrl ? { ANTHROPIC_BASE_URL: claudeBaseUrl } : {}),
        ANTHROPIC_MODEL: model,
        ANTHROPIC_CUSTOM_MODEL_OPTION: model,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: modelName,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: modelName,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: modelName,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: modelName,
      },
    }
    env = settings.env
    await writeScopedFile('settings', `${JSON.stringify(settings, null, 2)}\n`)
    await writeScopedFile('mcp', claudeMcpConfigJson(scope.profile))
    await writeScopedFile('prompt', hermesPromptDocument())

    const settingsPath = join(rootDir, 'settings.json')
    const mcpPath = join(rootDir, 'mcp.json')
    args = [
      '--settings',
      settingsPath,
      ...(input.isolateSettings ? ['--setting-sources', 'local'] : []),
      '--mcp-config',
      mcpPath,
      ...claudeCodePermissionArgs(),
    ]
  } else {
    if (apiMode !== 'chat_completions' && apiMode !== 'codex_responses' && apiMode !== 'anthropic_messages') {
      const err = new Error('Codex launch only supports OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages providers')
      ;(err as any).status = 400
      throw err
    }
    const proxyTarget = baseUrl && apiKey
      ? registerCodexProxyTarget({
          profile: scope.profile,
          provider,
          model,
          baseUrl,
          apiKey,
          apiMode,
          agentId: tool.id,
          agentSessionId: input.agentSessionId,
          chatSessionId: input.sessionId,
        })
      : null
    const codexBaseUrl = proxyTarget?.baseUrl || baseUrl
    const codexApiKey = proxyTarget?.token || apiKey
    const providerId = 'custom'
    const catalogPath = join(rootDir, CODEX_MODEL_CATALOG_FILE)
    const configToml = [
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      `model_provider = ${JSON.stringify(providerId)}`,
      `model = ${JSON.stringify(model)}`,
      'model_reasoning_summary = "auto"',
      'disable_response_storage = true',
      '',
      `[model_providers.${providerId}]`,
      `name = ${JSON.stringify(provider)}`,
      ...(codexBaseUrl ? [`base_url = ${JSON.stringify(codexBaseUrl)}`] : []),
      'wire_api = "responses"',
      'requires_openai_auth = false',
      ...(codexApiKey ? [`experimental_bearer_token = ${JSON.stringify(codexApiKey)}`] : []),
      '',
      codexMcpConfigToml(scope.profile),
    ].join('\n')
    const catalog = buildCodexModelCatalog({
      profile: scope.profile,
      provider,
      model,
      presetModels: Array.isArray(preset?.models) ? preset.models : [],
    })
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8')
    files.push({ key: 'model_catalog', path: CODEX_MODEL_CATALOG_FILE, absolutePath: catalogPath })
    await writeScopedFile('config', configToml)
    await writeScopedFile('auth', `${JSON.stringify({}, null, 2)}\n`)

    env = { CODEX_HOME: rootDir }
    args = ['--model', model]
  }

  let shellCommand = buildLaunchShellCommand({
    workspaceDir,
    env,
    command: tool.command,
    args,
  })
  const launcherPath = await writeLauncherScript({
    rootDir,
    workspaceDir,
    env,
    command: tool.command,
    args,
  })
  files.push({
    key: 'launcher',
    path: process.platform === 'win32' ? WINDOWS_LAUNCHER_FILE : POSIX_LAUNCHER_FILE,
    absolutePath: launcherPath,
  })
  shellCommand = buildLauncherShellCommand(workspaceDir, launcherPath)

  return {
    agentId: tool.id,
    mode,
    profile: scope.profile,
    provider: scope.provider,
    model,
    rootDir,
    workspaceDir,
    command: tool.command,
    args,
    env,
    shellCommand,
    files,
  }
}

export async function startCodingAgentRun(
  id: string,
  input: CodingAgentLaunchInput & { sessionId: string },
  state?: SessionState,
): Promise<CodingAgentRunStartResult> {
  const sessionId = String(input.sessionId || '').trim()
  if (!sessionId) {
    const err = new Error('sessionId is required')
    ;(err as any).status = 400
    throw err
  }
  const existingSession = getSession(sessionId)
  const sessionSource = input.sessionSource === 'global_agent' ? 'global_agent' : 'coding_agent'
  const existingAgentSessionId = existingSession?.agent_session_id || ''
  const resolvedInput = await resolveStoredProviderLaunchInput(input, existingSession)
  const requestedMode = resolvedInput.mode === 'global' ? 'global' : 'scoped'
  const requestedProvider = String(resolvedInput.provider || '').trim().toLowerCase()
  if (requestedMode !== 'global' && CODING_AGENT_SCOPED_AUTH_PROVIDERS.has(requestedProvider)) {
    const err = new Error('Coding agent scoped mode does not support OAuth/subscription providers. Use global mode or select an API-key provider.')
    ;(err as any).status = 400
    throw err
  }
  if (requestedMode !== 'global' && (!String(resolvedInput.baseUrl || '').trim() || !String(resolvedInput.apiKey || '').trim())) {
    const err = new Error('Coding agent provider credentials are missing. Re-select the provider/model or update the provider API key before continuing this session.')
    ;(err as any).status = 400
    throw err
  }
  const agentSessionId = resolvedInput.agentSessionId || existingAgentSessionId || makeAgentSessionId()
  const canResumeNativeSession = existingSession
    ? storedCodingAgentMode(existingSession) === requestedMode &&
      (existingSession.agent === (id === 'codex' ? 'codex' : 'claude') || !existingSession.agent)
    : false
  const existingNativeSessionId = canResumeNativeSession ? existingSession?.agent_native_session_id || '' : ''
  const agentNativeSessionId = resolvedInput.agentNativeSessionId || existingNativeSessionId || (id === 'claude-code' ? randomUUID() : '')
  const launch = await prepareCodingAgentLaunch(id, {
    ...resolvedInput,
    sessionId,
    agentSessionId,
    isolateSettings: true,
  })
  const runtimeEnv = process.platform === 'win32'
    ? {
        ...(await commandEnv()),
        ...launch.env,
      }
    : launch.env
  const runtimeCommand = process.platform === 'win32'
    ? await resolveCommandForExecution(launch.command, runtimeEnv)
    : launch.command
  const persistedProvider = String(resolvedInput.provider || launch.provider || '').trim() || launch.provider
  const started = codingAgentRunManager.start({
    agentSessionId,
    agentId: launch.agentId,
    mode: launch.mode,
    profile: launch.profile,
    provider: persistedProvider,
    model: launch.model,
    sessionId,
    agentNativeSessionId,
    nativeResume: Boolean(existingNativeSessionId),
    command: runtimeCommand,
    args: launch.args,
    shellCommand: launch.shellCommand,
    workspaceDir: launch.workspaceDir,
    env: runtimeEnv,
    state,
    sessionSource: sessionSource === 'global_agent' ? 'global_agent' : undefined,
  })
  updateSession(sessionId, {
    source: sessionSource,
    agent: launch.agentId === 'codex' ? 'codex' : 'claude',
    agent_mode: launch.mode,
    agent_session_id: agentSessionId,
    agent_native_session_id: agentNativeSessionId,
    model: launch.model,
    provider: persistedProvider,
    workspace: launch.workspaceDir,
  })
  return {
    ...launch,
    provider: persistedProvider,
    agentSessionId,
    sessionId,
    pid: started.pid,
  }
}

export function sendCodingAgentRunInput(sessionId: string, input: string, systemPrompt?: string): { runId: string } {
  return codingAgentRunManager.send(sessionId, input, { systemPrompt })
}

export function stopCodingAgentRun(sessionId: string): { stopped: boolean } {
  return { stopped: codingAgentRunManager.stop(sessionId) }
}

export async function openCodingAgentNativeTerminal(id: string, input: CodingAgentLaunchInput): Promise<CodingAgentNativeLaunchResult> {
  const launch = await prepareCodingAgentLaunch(id, input)
  const terminal = await openNativeTerminal(launch.shellCommand)
  return {
    ...launch,
    nativeTerminal: true,
    terminal,
  }
}
