import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { logger } from '../../logger'
import { detectHermesHome, getHermesBin } from '../hermes-path'
import { DEFAULT_AGENT_BRIDGE_ENDPOINT } from './client'

const DEFAULT_AGENT_BRIDGE_STARTUP_TIMEOUT_MS = 120000

export interface AgentBridgeManagerOptions {
  endpoint?: string
  python?: string
  agentRoot?: string
  hermesHome?: string
  startupTimeoutMs?: number
}

export interface BridgeCommand {
  command: string
  argsPrefix: string[]
  agentRoot?: string
  hermesHome: string
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function pathCandidates(agentRoot?: string): string[] {
  if (!agentRoot) return []
  return process.platform === 'win32'
    ? [
        join(agentRoot, 'venv', 'Scripts', 'python.exe'),
        join(agentRoot, 'venv', 'Scripts', 'python3.exe'),
        join(agentRoot, '.venv', 'Scripts', 'python.exe'),
        join(agentRoot, '.venv', 'Scripts', 'python3.exe'),
      ]
    : [
        join(agentRoot, 'venv', 'bin', 'python3'),
        join(agentRoot, 'venv', 'bin', 'python'),
        join(agentRoot, '.venv', 'bin', 'python3'),
        join(agentRoot, '.venv', 'bin', 'python'),
      ]
}

function uvCandidates(agentRoot?: string): string[] {
  if (!agentRoot) {
    return [
      process.env.HERMES_AGENT_BRIDGE_UV,
      process.env.UV,
    ].filter((value): value is string => !!value && value.trim().length > 0)
  }
  return [
    process.env.HERMES_AGENT_BRIDGE_UV,
    process.env.UV,
    ...(process.platform === 'win32'
      ? [
          agentRoot ? join(agentRoot, 'venv', 'Scripts', 'uv.exe') : '',
          agentRoot ? join(agentRoot, 'venv', 'Scripts', 'uv.cmd') : '',
          agentRoot ? join(agentRoot, '.venv', 'Scripts', 'uv.exe') : '',
          agentRoot ? join(agentRoot, '.venv', 'Scripts', 'uv.cmd') : '',
        ]
      : [
          agentRoot ? join(agentRoot, 'venv', 'bin', 'uv') : '',
          agentRoot ? join(agentRoot, '.venv', 'bin', 'uv') : '',
        ]),
    'uv',
  ].filter((value): value is string => !!value && value.trim().length > 0)
}

function resolveExecutable(command: string): string | undefined {
  const trimmed = command.trim()
  if (!trimmed) return undefined
  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return existsSync(trimmed) ? resolve(trimmed) : undefined
  }
  try {
    const lookup = process.platform === 'win32'
      ? execFileSync('where.exe', [trimmed], { encoding: 'utf-8', windowsHide: true })
      : execFileSync('which', [trimmed], { encoding: 'utf-8' })
    return lookup.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  } catch {
    return undefined
  }
}

function agentRootFromHermesBin(): string | undefined {
  const hermesBin = resolveExecutable(getHermesBin())
  if (!hermesBin) return undefined

  const binDir = dirname(hermesBin)
  const rootCandidates = [
    resolve(binDir, '..'),
    resolve(binDir, '..', '..'),
    resolve(binDir, '..', 'hermes-agent'),
    resolve(binDir, '..', '..', 'hermes-agent'),
  ]
  const root = rootCandidates.find(candidate => existsSync(join(candidate, 'run_agent.py')))
  if (root) return root

  try {
    const first = readFileSync(hermesBin, 'utf-8').split(/\r?\n/, 1)[0]
    const match = first.match(/^#!\s*(.+)$/)
    const python = match?.[1]?.trim().split(/\s+/)[0]
    if (python) {
      const pyDir = dirname(python)
      const shebangRootCandidates = [
        resolve(pyDir, '..', '..'),
        resolve(pyDir, '..', '..', 'hermes-agent'),
      ]
      return shebangRootCandidates.find(candidate => existsSync(join(candidate, 'run_agent.py')))
    }
  } catch {}
  return undefined
}

function hermesBinPython(): string | undefined {
  const hermesBin = resolveExecutable(getHermesBin())
  if (!hermesBin) return undefined
  try {
    const first = readFileSync(hermesBin, 'utf-8').split(/\r?\n/, 1)[0]
    const match = first.match(/^#!\s*(.+)$/)
    const python = match?.[1]?.trim().split(/\s+/)[0]
    return python && existsSync(python) ? python : undefined
  } catch {
    return undefined
  }
}

function firstExistingExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) && !candidate.includes('/') && !candidate.includes('\\')) {
      const resolved = resolveExecutable(candidate)
      if (resolved) return resolved
      continue
    }
    try {
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return undefined
}

function resolveAgentRoot(explicit?: string, hermesHome = detectHermesHome()): string | undefined {
  const candidates = [
    explicit,
    process.env.HERMES_AGENT_ROOT,
    join(hermesHome, 'hermes-agent'),
    agentRootFromHermesBin(),
    process.cwd(),
    join(process.cwd(), 'hermes-agent'),
  ].filter((value): value is string => !!value && value.trim().length > 0)
  return candidates.find(candidate => existsSync(join(candidate, 'run_agent.py')))
}

export function resolveAgentBridgeCommand(options: AgentBridgeManagerOptions = {}): BridgeCommand {
  const hermesHome = options.hermesHome || detectHermesHome()
  const agentRoot = resolveAgentRoot(options.agentRoot, hermesHome)
  const explicitPython = options.python || process.env.HERMES_AGENT_BRIDGE_PYTHON
  if (explicitPython) {
    return { command: explicitPython, argsPrefix: [], agentRoot, hermesHome }
  }

  const venvPython = firstExistingExecutable(pathCandidates(agentRoot))
  if (venvPython) {
    return { command: venvPython, argsPrefix: [], agentRoot, hermesHome }
  }

  const shebangPython = hermesBinPython()
  if (shebangPython && existsSync(shebangPython)) {
    return { command: shebangPython, argsPrefix: [], agentRoot, hermesHome }
  }

  const uv = firstExistingExecutable(uvCandidates(agentRoot))
  if (uv) {
    const prefix = ['run']
    if (agentRoot) prefix.push('--project', agentRoot)
    prefix.push('python')
    return { command: uv, argsPrefix: prefix, agentRoot, hermesHome }
  }

  const fallback = firstExistingExecutable([
    process.env.PYTHON || '',
    ...(process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']),
  ]) || (process.platform === 'win32' ? 'python' : 'python3')
  return { command: fallback, argsPrefix: [], agentRoot, hermesHome }
}

function bridgeScriptPath(): string {
  const candidates = [
    // Built server: dist/server/index.js -> dist/server/agent-bridge/hermes_bridge.py
    resolve(__dirname, 'agent-bridge', 'hermes_bridge.py'),
    // ts-node/dev source tree.
    resolve(__dirname, 'services/hermes/agent-bridge/hermes_bridge.py'),
    resolve(process.cwd(), 'packages/server/src/services/hermes/agent-bridge/hermes_bridge.py'),
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) {
    throw new Error(`agent bridge Python script not found. Tried: ${candidates.join(', ')}`)
  }
  return found
}

export class AgentBridgeManager {
  readonly endpoint: string
  private readonly options: AgentBridgeManagerOptions
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private ready = false

  constructor(options: AgentBridgeManagerOptions = {}) {
    this.options = options
    this.endpoint = options.endpoint || process.env.HERMES_AGENT_BRIDGE_ENDPOINT || DEFAULT_AGENT_BRIDGE_ENDPOINT
  }

  get running(): boolean {
    return !!this.child && !this.child.killed && this.ready
  }

  async start(): Promise<void> {
    if (this.running) return
    if (this.starting) return this.starting
    this.starting = this.startProcess()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startProcess(): Promise<void> {
    const script = bridgeScriptPath()
    const command = resolveAgentBridgeCommand(this.options)
    const args = [...command.argsPrefix, script, '--endpoint', this.endpoint]
    const agentRoot = command.agentRoot
    const hermesHome = command.hermesHome
    if (agentRoot) args.push('--agent-root', agentRoot)
    if (hermesHome) args.push('--hermes-home', hermesHome)

    const env = {
      ...process.env,
      HERMES_AGENT_BRIDGE_ENDPOINT: this.endpoint,
      HERMES_HOME: hermesHome,
      ...(agentRoot ? { HERMES_AGENT_ROOT: agentRoot } : {}),
    }

    logger.info('[agent-bridge] starting: %s %s', command.command, args.join(' '))
    const child = spawn(command.command, args, {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.ready = false

    child.once('exit', (code, signal) => {
      logger.warn('[agent-bridge] exited code=%s signal=%s', code, signal)
      this.ready = false
      if (this.child === child) this.child = null
    })

    child.stderr?.on('data', chunk => {
      const text = String(chunk).trim()
      if (text) logger.warn('[agent-bridge] %s', text)
    })

    await new Promise<void>((resolveReady, rejectReady) => {
      let buffered = ''
      const startupTimeoutMs = this.options.startupTimeoutMs
        ?? envPositiveInt('HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS')
        ?? DEFAULT_AGENT_BRIDGE_STARTUP_TIMEOUT_MS
      const timeout = setTimeout(() => {
        cleanup()
        rejectReady(new Error(`agent bridge did not become ready within ${startupTimeoutMs}ms`))
      }, startupTimeoutMs)

      const cleanup = () => {
        clearTimeout(timeout)
        child.off('exit', onExitBeforeReady)
        child.off('error', onError)
      }

      const onError = (err: Error) => {
        cleanup()
        child.stdout?.off('data', onStdout)
        rejectReady(err)
      }

      const onExitBeforeReady = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        child.stdout?.off('data', onStdout)
        rejectReady(new Error(`agent bridge exited before ready code=${code} signal=${signal}`))
      }

      let readyResolved = false
      const onStdout = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        buffered += text
        for (;;) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) break
          const line = buffered.slice(0, newline).trim()
          buffered = buffered.slice(newline + 1)
          if (!line) continue
          logger.info('[agent-bridge] %s', line)
          if (!readyResolved) {
            try {
              const parsed = JSON.parse(line)
              if (parsed?.event === 'ready') {
                this.ready = true
                readyResolved = true
                cleanup()
                resolveReady()
                return
              }
            } catch {}
          }
        }
      }

      child.once('error', onError)
      child.once('exit', onExitBeforeReady)
      child.stdout?.on('data', onStdout)
    })

    logger.info('[agent-bridge] ready at %s', this.endpoint)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.ready = false
    this.child = null

    await new Promise<void>((resolveStop) => {
      const timeout = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
        resolveStop()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolveStop()
      })
      if (!child.killed) {
        child.kill('SIGTERM')
      }
    })
  }
}

let singleton: AgentBridgeManager | null = null

export function getAgentBridgeManager(): AgentBridgeManager {
  if (!singleton) singleton = new AgentBridgeManager()
  return singleton
}

export async function startAgentBridgeManager(): Promise<AgentBridgeManager> {
  const manager = getAgentBridgeManager()
  await manager.start()
  return manager
}
