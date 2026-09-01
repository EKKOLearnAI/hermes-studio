import { existsSync } from 'fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { writeManagedPromptFile } from '../prompt-file'
import { GROK_API_KEY_ENV, GROK_PROVIDER_ID } from './definition'

const MANAGED_MCP_NAMES = new Set([
  'hermes-studio-api',
  'hermes-studio-browser',
  'hermes-studio-devices',
  'hermes-studio-use',
  'hermes-studio',
  'hermes-studio-mcp',
  'hermes-web-ui-mcp',
])
const COPIED_GLOBAL_DIRS = new Set([
  'agents',
  'hooks',
  'personas',
  'plugins',
  'roles',
  'rules',
  'skills',
  'workflows',
])
const MANAGED_MCP_MARKER = 'HERMES_WEB_UI_MANAGED_MCP'
const SCOPED_IDENTITY_BEGIN = '<!-- BEGIN HERMES STUDIO GROK SCOPED IDENTITY -->'
const SCOPED_IDENTITY_END = '<!-- END HERMES STUDIO GROK SCOPED IDENTITY -->'

export interface GrokRuntimeFiles {
  promptFile: string
  files: Array<{ key: string; path: string; absolutePath: string }>
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

function mcpServerName(header: string): string {
  const match = header.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([^\].]+))(?:\.[^\]]+)?\]\s*$/)
  return String(match?.[1] || match?.[2] || '').trim()
}

export function stripManagedGrokMcp(content: string): string {
  const blocks: string[][] = []
  let current: string[] = []
  for (const line of String(content || '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line) && current.length > 0) {
      blocks.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)

  return blocks
    .filter((block) => {
      const name = mcpServerName(block[0] || '')
      if (!name) return true
      return !MANAGED_MCP_NAMES.has(name) && !block.join('\n').includes(MANAGED_MCP_MARKER)
    })
    .map(block => block.join('\n').trimEnd())
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export function mergeGrokConfigWithManagedMcp(content: string, managedMcpToml: string): string {
  return [stripManagedGrokMcp(content), managedMcpToml.trim()]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n')
}

async function copyGlobalDirectory(source: string, target: string): Promise<void> {
  if (await pathExists(target)) return
  await cp(source, target, {
    recursive: true,
    dereference: true,
    errorOnExist: false,
    force: false,
    preserveTimestamps: true,
  })
}

function shouldCopyGlobalFile(name: string): boolean {
  if (name === 'AGENTS.md' || name === 'config.toml') return false
  if (name.endsWith('.lock') || name.endsWith('.pid') || name.endsWith('.sock')) return false
  if (name.endsWith('.db') || name.endsWith('.db-shm') || name.endsWith('.db-wal')) return false
  if (name.endsWith('.sqlite') || name.endsWith('.sqlite-shm') || name.endsWith('.sqlite-wal')) return false
  return !name.endsWith('.log')
}

export async function prepareGlobalGrokRuntime(input: {
  sourceHome: string
  rootDir: string
  systemPrompt: string
  managedMcpToml: string
}): Promise<GrokRuntimeFiles> {
  await mkdir(input.rootDir, { recursive: true, mode: 0o700 })
  if (input.sourceHome !== input.rootDir && existsSync(input.sourceHome)) {
    for (const entry of await readdir(input.sourceHome, { withFileTypes: true })) {
      const source = join(input.sourceHome, entry.name)
      const target = join(input.rootDir, entry.name)
      if (entry.isFile() && shouldCopyGlobalFile(entry.name)) {
        if (!await pathExists(target)) await copyFile(source, target)
      } else if (entry.isDirectory() && COPIED_GLOBAL_DIRS.has(entry.name)) {
        await copyGlobalDirectory(source, target)
      }
    }
  }

  const configPath = join(input.rootDir, 'config.toml')
  const promptFile = join(input.rootDir, 'AGENTS.md')
  await writeFile(
    configPath,
    mergeGrokConfigWithManagedMcp(await readText(join(input.sourceHome, 'config.toml')), input.managedMcpToml),
    'utf-8',
  )
  await writeManagedPromptFile(
    promptFile,
    input.systemPrompt,
    await readText(join(input.sourceHome, 'AGENTS.md')),
  )
  return {
    promptFile,
    files: [
      { key: 'config', path: 'config.toml', absolutePath: configPath },
      { key: 'agents', path: 'AGENTS.md', absolutePath: promptFile },
    ],
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function promptIdentityValue(value: string): string {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim()
}

export function scopedGrokIdentityPrompt(provider: string, model: string): string {
  const providerId = promptIdentityValue(provider)
  const modelId = promptIdentityValue(model)
  return [
    SCOPED_IDENTITY_BEGIN,
    '## Runtime model identity',
    '',
    'You are running inside Grok Build as the coding-agent harness. Grok Build is the shell, not necessarily the upstream language model.',
    `The selected upstream provider is \`${providerId}\` and the exact model ID is \`${modelId}\`.`,
    `When asked which model you are, answer with \`${modelId}\` and, when useful, provider \`${providerId}\`. Do not answer only "Grok" unless that is the selected model ID.`,
    SCOPED_IDENTITY_END,
  ].join('\n')
}

export async function prepareScopedGrokRuntime(input: {
  rootDir: string
  provider: string
  model: string
  displayName: string
  proxyBaseUrl: string
  contextWindow: number
  outputLimit: number
  reasoningEffort: string
  systemPrompt: string
  userInstructions: string
  managedMcpToml: string
}): Promise<GrokRuntimeFiles> {
  await mkdir(input.rootDir, { recursive: true, mode: 0o700 })
  const configPath = join(input.rootDir, 'config.toml')
  const promptFile = join(input.rootDir, 'AGENTS.md')
  const config = [
    '[models]',
    `default = ${tomlString(GROK_PROVIDER_ID)}`,
    ...(input.reasoningEffort ? [`default_reasoning_effort = ${tomlString(input.reasoningEffort)}`] : []),
    '',
    `[model.${GROK_PROVIDER_ID}]`,
    `model = ${tomlString(input.model)}`,
    `name = ${tomlString(input.displayName)}`,
    `base_url = ${tomlString(input.proxyBaseUrl)}`,
    `env_key = ${tomlString(GROK_API_KEY_ENV)}`,
    'api_backend = "responses"',
    `context_window = ${Math.max(1, Math.floor(input.contextWindow))}`,
    `max_completion_tokens = ${Math.max(1, Math.floor(input.outputLimit))}`,
    '',
    input.managedMcpToml.trim(),
    '',
  ].join('\n')
  await writeFile(configPath, config, 'utf-8')
  await writeManagedPromptFile(
    promptFile,
    input.systemPrompt,
    [scopedGrokIdentityPrompt(input.provider, input.model), input.userInstructions.trim()]
      .filter(Boolean)
      .join('\n\n'),
  )
  return {
    promptFile,
    files: [
      { key: 'config', path: 'config.toml', absolutePath: configPath },
      { key: 'agents', path: 'AGENTS.md', absolutePath: promptFile },
    ],
  }
}
