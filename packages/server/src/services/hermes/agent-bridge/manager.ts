import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { createServer } from 'net'
import { dirname, isAbsolute, join, resolve } from 'path'
import { logger } from '../../logger'
import { detectHermesHome, getHermesBin } from '../hermes-path'
import { DEFAULT_AGENT_BRIDGE_ENDPOINT } from './client'

const DEFAULT_AGENT_BRIDGE_STARTUP_TIMEOUT_MS = 120000
const DEFAULT_AGENT_BRIDGE_RESTART_DELAY_MS = 1000
const MAX_AGENT_BRIDGE_RESTART_DELAY_MS = 30000
const OPENROUTER_WEB_UI_ATTRIBUTION_ENV = {
  HERMES_OPENROUTER_APP_REFERER: 'https://ekkolearnai.com',
  HERMES_OPENROUTER_APP_TITLE: 'Hermes Web UI',
  HERMES_OPENROUTER_APP_CATEGORIES: 'cli-agent,personal-agent',
} as const

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

export interface AgentBridgeManagerRuntimeState {
  endpoint: string
  running: boolean
  ready: boolean
  pid?: number
  starting: boolean
  stopping: boolean
  restartScheduled: boolean
  restartAttempts: number
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function buildAgentBridgeProcessEnv(endpoint: string, hermesHome: string | undefined, agentRoot: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HERMES_AGENT_BRIDGE_ENDPOINT: endpoint,
    HERMES_HOME: hermesHome,
    HERMES_OPENROUTER_APP_REFERER: process.env.HERMES_OPENROUTER_APP_REFERER || OPENROUTER_WEB_UI_ATTRIBUTION_ENV.HERMES_OPENROUTER_APP_REFERER,
    HERMES_OPENROUTER_APP_TITLE: process.env.HERMES_OPENROUTER_APP_TITLE || OPENROUTER_WEB_UI_ATTRIBUTION_ENV.HERMES_OPENROUTER_APP_TITLE,
    HERMES_OPENROUTER_APP_CATEGORIES: process.env.HERMES_OPENROUTER_APP_CATEGORIES || OPENROUTER_WEB_UI_ATTRIBUTION_ENV.HERMES_OPENROUTER_APP_CATEGORIES,
    ...(agentRoot ? { HERMES_AGENT_ROOT: agentRoot } : {}),
  }
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
    resolve(binDir, '..', 'lib', 'hermes-agent'),
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
        resolve(pyDir, '..', '..', 'lib', 'hermes-agent'),
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
    '/usr/local/lib/hermes-agent',
    '/usr/local/hermes-agent',
    '/opt/hermes/hermes-agent',
    '/opt/hermes-agent',
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

function isTcpEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('tcp://')
}

async function canListenTcpEndpoint(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint)
  const host = url.hostname || '127.0.0.1'
  const port = Number(url.port)
  if (!Number.isFinite(port) || port <= 0) return false

  return await new Promise<boolean>((resolveAvailable) => {
    const probe = createServer()
    const done = (available: boolean) => {
      probe.removeAllListeners()
      resolveAvailable(available)
    }
    probe.once('error', () => done(false))
    probe.listen(port, host, () => {
      probe.close(() => done(true))
    })
  })
}

function tcpEndpointPort(endpoint: string): number | undefined {
  if (!isTcpEndpoint(endpoint)) return undefined
  const url = new URL(endpoint)
  const port = Number(url.port)
  return Number.isFinite(port) && port > 0 ? port : undefined
}

function windowsListeningPidsOnPort(port: number): number[] {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true }).toString('utf8')
    const pids = new Set<number>()
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      const [proto, localAddress, , state, pidRaw] = parts
      if (proto.toUpperCase() !== 'TCP' || state.toUpperCase() !== 'LISTENING') continue
      if (!localAddress.endsWith(`:${port}`)) continue
      const pid = Number(pidRaw)
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
    }
    return [...pids]
  } catch {
    return []
  }
}

async function waitForTcpEndpoint(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canListenTcpEndpoint(endpoint)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return canListenTcpEndpoint(endpoint)
}

async function killWindowsEndpointOccupants(endpoint: string): Promise<void> {
  const port = tcpEndpointPort(endpoint)
  if (!port) return
  const pids = windowsListeningPidsOnPort(port)
  if (!pids.length) return
  for (const pid of pids) {
    try {
      logger.warn('[agent-bridge] killing stale process tree pid=%d on bridge port %d', pid, port)
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf-8', windowsHide: true })
    } catch (err) {
      logger.warn(err, '[agent-bridge] failed to kill stale bridge process pid=%d', pid)
    }
  }
  await waitForTcpEndpoint(endpoint, 3000)
}

export class AgentBridgeManager {
  endpoint: string
  private readonly options: AgentBridgeManagerOptions
  private readonly explicitEndpoint: boolean
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private ready = false
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private restartAttempts = 0

  constructor(options: AgentBridgeManagerOptions = {}) {
    this.options = options
    this.explicitEndpoint = Boolean(options.endpoint || process.env.HERMES_AGENT_BRIDGE_ENDPOINT)
    this.endpoint = options.endpoint || process.env.HERMES_AGENT_BRIDGE_ENDPOINT || DEFAULT_AGENT_BRIDGE_ENDPOINT
  }

  get running(): boolean {
    return !!this.child && !this.child.killed && this.ready
  }

  getRuntimeState(): AgentBridgeManagerRuntimeState {
    return {
      endpoint: this.endpoint,
      running: this.running,
      ready: this.ready,
      pid: this.child?.pid,
      starting: !!this.starting,
      stopping: this.stopping,
      restartScheduled: !!this.restartTimer,
      restartAttempts: this.restartAttempts,
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    if (this.starting) return this.starting
    this.stopping = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
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
    await this.prepareEndpoint()
    const args = [...command.argsPrefix, script, '--endpoint', this.endpoint]
    const agentRoot = command.agentRoot
    const hermesHome = command.hermesHome
    if (agentRoot) args.push('--agent-root', agentRoot)
    if (hermesHome) args.push('--hermes-home', hermesHome)

    const env = buildAgentBridgeProcessEnv(this.endpoint, hermesHome, agentRoot)

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
      const shouldRestart = this.ready && !this.stopping && this.child === child && this.autoRestartEnabled()
      logger.warn('[agent-bridge] exited code=%s signal=%s', code, signal)
      this.ready = false
      if (this.child === child) this.child = null
      if (shouldRestart) this.scheduleRestart(code, signal)
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
                this.restartAttempts = 0
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

  private async prepareEndpoint(): Promise<void> {
    if (!this.explicitEndpoint && process.platform === 'win32' && isTcpEndpoint(this.endpoint)) {
      if (!(await canListenTcpEndpoint(this.endpoint))) {
        await killWindowsEndpointOccupants(this.endpoint)
      }
    }
    process.env.HERMES_AGENT_BRIDGE_ENDPOINT = this.endpoint
  }

  private autoRestartEnabled(): boolean {
    const raw = String(process.env.HERMES_AGENT_BRIDGE_AUTO_RESTART || '').trim().toLowerCase()
    return !['0', 'false', 'no', 'off'].includes(raw)
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.restartTimer || this.stopping) return
    this.restartAttempts += 1
    const envDelay = envPositiveInt('HERMES_AGENT_BRIDGE_RESTART_DELAY_MS') ?? DEFAULT_AGENT_BRIDGE_RESTART_DELAY_MS
    const delayMs = Math.min(
      MAX_AGENT_BRIDGE_RESTART_DELAY_MS,
      envDelay * Math.max(1, this.restartAttempts),
    )
    logger.warn(
      '[agent-bridge] broker exited unexpectedly code=%s signal=%s; restarting in %dms (attempt %d)',
      code,
      signal,
      delayMs,
      this.restartAttempts,
    )
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.start().catch((err) => {
        logger.warn(err, '[agent-bridge] automatic restart failed')
        if (!this.stopping) this.scheduleRestart(null, null)
      })
    }, delayMs)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
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
