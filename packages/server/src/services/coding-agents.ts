import { execFile } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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
}

export interface CodingAgentConfigFileDefinition {
  key: string
  path: string
  absolutePath: string
  language: string
}

export interface CodingAgentConfigFileContent extends CodingAgentConfigFileDefinition {
  content: string
  exists: boolean
  size: number
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

const CONFIG_FILE_DEFINITIONS: Record<CodingAgentId, Array<Omit<CodingAgentConfigFileDefinition, 'absolutePath'>>> = {
  'claude-code': [
    { key: 'settings', path: '~/.claude/settings.json', language: 'json' },
    { key: 'mcp', path: '~/.claude.json', language: 'json' },
    { key: 'prompt', path: '~/.claude/CLAUDE.md', language: 'markdown' },
  ],
  codex: [
    { key: 'auth', path: '~/.codex/auth.json', language: 'json' },
    { key: 'config', path: '~/.codex/config.toml', language: 'ini' },
    { key: 'agents', path: '~/.codex/AGENTS.md', language: 'markdown' },
  ],
}

const installingTools = new Set<CodingAgentId>()
const deletingTools = new Set<CodingAgentId>()
let cachedGlobalNpmBin: string | null | undefined
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

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function getConfigFileDefinition(id: string, key: string): CodingAgentConfigFileDefinition | null {
  const tool = getCodingAgentDefinition(id)
  if (!tool) return null
  const definition = CONFIG_FILE_DEFINITIONS[tool.id].find(file => file.key === key)
  if (!definition) return null
  return {
    ...definition,
    absolutePath: expandHomePath(definition.path),
  }
}

function getCurrentNodeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [getNodeBinDir(), process.env.PATH].filter(Boolean).join(delimiter),
    npm_node_execpath: process.execPath,
  }
}

async function runNpm(args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const npmCli = getNpmCliPath()
  const command = npmCli ? process.execPath : getNpmBin()
  const commandArgs = npmCli ? [npmCli, ...args] : args
  return execFileAsync(command, commandArgs, {
    encoding: 'utf-8',
    timeout: options.timeout,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...getCurrentNodeEnv(),
      ...options.env,
    },
  })
}

function normalizeError(err: any): string {
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
  const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : ''
  const message = stderr || stdout || err?.message || String(err)
  return message.split(/\r?\n/).filter(Boolean).slice(0, 4).join('\n')
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
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  } catch {
    return []
  }
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
  if (npmBin) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
    const currentPath = env[pathKey] || ''
    if (!currentPath.split(delimiter).includes(npmBin)) {
      env[pathKey] = currentPath ? `${npmBin}${delimiter}${currentPath}` : npmBin
    }
  }
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
    ...file,
    absolutePath: expandHomePath(file.path),
  }))
}

export async function getCodingAgentStatus(definition: CodingAgentDefinition): Promise<CodingAgentToolStatus> {
  try {
    const { stdout, stderr } = await execFileAsync(definition.command, ['--version'], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
      env: await commandEnv(),
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
    }
  } finally {
    deletingTools.delete(tool.id)
  }
}

export async function readCodingAgentConfigFile(id: string, key: string): Promise<CodingAgentConfigFileContent> {
  const definition = getConfigFileDefinition(id, key)
  if (!definition) {
    const err = new Error('Unknown coding agent config file')
    ;(err as any).status = 404
    throw err
  }

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
      content: await readFile(definition.absolutePath, 'utf-8'),
      exists: true,
      size: info.size,
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
    return {
      ...definition,
      content: '',
      exists: false,
      size: 0,
    }
  }
}

export async function writeCodingAgentConfigFile(id: string, key: string, content: string): Promise<CodingAgentConfigFileContent> {
  const definition = getConfigFileDefinition(id, key)
  if (!definition) {
    const err = new Error('Unknown coding agent config file')
    ;(err as any).status = 404
    throw err
  }

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
    content,
    exists: true,
    size: buffer.length,
  }
}
