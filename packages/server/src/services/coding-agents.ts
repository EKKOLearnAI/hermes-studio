import { execFile } from 'child_process'
import { existsSync } from 'fs'
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

export interface CodingAgentInstallResult extends CodingAgentsStatus {
  success: boolean
  tool: CodingAgentToolStatus
  message?: string
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

const installingTools = new Set<CodingAgentId>()
let cachedGlobalNpmBin: string | null | undefined

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

export async function installCodingAgent(id: string): Promise<CodingAgentInstallResult> {
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
