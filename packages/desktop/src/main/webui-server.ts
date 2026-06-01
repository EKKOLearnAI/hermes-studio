import { ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, delimiter, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  bundledBrowserExecutable,
  bundledGit,
  bundledNode,
  gitPathDirs,
  webuiServerEntry,
  webuiDir,
  hermesBin,
  webUiHome,
  hermesHome,
  nodeBinDir,
  tokenFile,
  pythonDir,
} from './paths'

const DEFAULT_PORT = 8748
const DEFAULT_READY_TIMEOUT_MS = 30_000
const AGENT_BRIDGE_STARTED_MARKER = '[bootstrap] agent bridge started'
const AGENT_BRIDGE_FAILED_MARKER = '[bootstrap] agent bridge failed to start'
const execFileAsync = promisify(execFile)

let serverProc: ChildProcess | null = null
let cachedToken: string | null = null

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid || proc.killed) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', () => undefined)
      return
    } catch {
      /* fall through */
    }
  }
  try {
    proc.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function readyTimeoutMs(): number {
  return envPositiveInt('HERMES_DESKTOP_READY_TIMEOUT_MS') || DEFAULT_READY_TIMEOUT_MS
}

function createAgentBridgeStartupTracker(): {
  observe: (chunk: Buffer) => void
  wait: (timeoutMs: number) => Promise<void>
} {
  let output = ''
  let state: 'pending' | 'started' | 'failed' = 'pending'
  let resolveReady: (() => void) | null = null
  let rejectReady: ((err: Error) => void) | null = null

  const settle = (nextState: 'started' | 'failed') => {
    if (state !== 'pending') return
    state = nextState
    if (nextState === 'started') {
      resolveReady?.()
    } else {
      rejectReady?.(new Error('Agent bridge failed to start'))
    }
  }

  const observe = (chunk: Buffer) => {
    if (state !== 'pending') return
    output = (output + chunk.toString('utf-8')).slice(-4096)
    if (output.includes(AGENT_BRIDGE_STARTED_MARKER)) {
      settle('started')
    } else if (output.includes(AGENT_BRIDGE_FAILED_MARKER)) {
      settle('failed')
    }
  }

  const wait = (timeoutMs: number) => {
    if (state === 'started') return Promise.resolve()
    if (state === 'failed') return Promise.reject(new Error('Agent bridge failed to start'))

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state !== 'pending') return
        state = 'failed'
        reject(new Error(`Agent bridge did not become ready within ${timeoutMs}ms`))
      }, timeoutMs)

      resolveReady = () => {
        clearTimeout(timer)
        resolve()
      }
      rejectReady = (err) => {
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  return { observe, wait }
}

function ensureToken(): string {
  if (cachedToken) return cachedToken
  const file = tokenFile()
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) {
    cachedToken = readFileSync(file, 'utf-8').trim()
    if (cachedToken) return cachedToken
  }
  cachedToken = randomBytes(32).toString('hex')
  writeFileSync(file, cachedToken + '\n', { mode: 0o600 })
  return cachedToken
}

// node-pty ships per-platform prebuilds with a `spawn-helper` binary that
// loses its +x bit when copied across some filesystems. Restore it.
function ensureNativeModules() {
  try {
    const helper = join(
      webuiDir(),
      'node_modules',
      'node-pty',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    )
    if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch {
    /* ignore */
  }
}

const COMMON_USER_BIN_DIRS = process.platform === 'win32'
  ? []
  : [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]
const PATH_MARKER_START = '__HERMES_DESKTOP_PATH_START__'
const PATH_MARKER_END = '__HERMES_DESKTOP_PATH_END__'

function mergePathEntries(...paths: Array<string | undefined | null>): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const rawPath of paths) {
    if (!rawPath) continue
    for (const entry of rawPath.split(delimiter)) {
      const trimmed = entry.trim()
      if (!trimmed) continue
      const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(trimmed)
    }
  }
  return entries.join(delimiter)
}

function extractMarkedPath(output: string): string | null {
  const start = output.lastIndexOf(PATH_MARKER_START)
  const end = output.lastIndexOf(PATH_MARKER_END)
  if (start < 0 || end <= start) return null
  const value = output.slice(start + PATH_MARKER_START.length, end).trim()
  return value || null
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
  if (process.platform === 'win32') return ''

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

async function getLoginShellPath(): Promise<string | null> {
  if (process.platform === 'win32') return null

  const shell = process.env.SHELL?.trim() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  if (!existsSync(shell)) return null

  try {
    const { stdout } = await execFileAsync(shell, ['-l', '-c', `printf '\\n${PATH_MARKER_START}%s${PATH_MARKER_END}\\n' "$PATH"`], {
      encoding: 'utf-8',
      timeout: 1500,
      windowsHide: true,
      env: process.env,
    })
    return extractMarkedPath(stdout) || stdout.trim() || null
  } catch {
    return null
  }
}

export function getToken(): string {
  return ensureToken()
}

export function getServerUrl(port = DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}`
}

async function getFreeTcpPort(): Promise<number> {
  return await new Promise((resolveFreePort, rejectFreePort) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectFreePort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolveFreePort(address.port)
        } else {
          rejectFreePort(new Error('Unable to allocate local TCP port'))
        }
      })
    })
  })
}

async function canBindTcpPort(port: number): Promise<boolean> {
  return await new Promise((resolveCanBind) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolveCanBind(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveCanBind(true))
    })
  })
}

async function getFreeTcpPortInRange(min: number, max: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = min + (randomBytes(2).readUInt16BE(0) % (max - min + 1))
    if (await canBindTcpPort(port)) return port
  }
  return getFreeTcpPort()
}

export async function startWebUiServer(port = DEFAULT_PORT): Promise<string> {
  ensureNativeModules()
  const token = ensureToken()
  const entry = webuiServerEntry()
  if (!existsSync(entry)) {
    throw new Error(`Web UI server entry not found at ${entry}. Run: npm run build:webui`)
  }

  const home = webUiHome()
  const agentHome = hermesHome()
  mkdirSync(home, { recursive: true })
  mkdirSync(agentHome, { recursive: true })

  // Tell agent-bridge to use the bundled Python directly. Otherwise the
  // bridge auto-detects Python from HERMES_BIN's shebang — which on our
  // setup is a #!/bin/sh wrapper, not a python interpreter, so detection
  // resolves to /bin/sh and the bridge crashes (exit code 2) immediately.
  const isWin = process.platform === 'win32'
  const bundledPython = isWin
    ? join(pythonDir(), 'python.exe')
    : join(pythonDir(), 'bin', 'python3')
  const bundledAgentBrowserBin = isWin
    ? join(pythonDir(), 'node')
    : join(pythonDir(), 'node', 'bin')
  const bundledNodeBin = nodeBinDir()
  const bundledGitPath = gitPathDirs().join(delimiter)
  const bridgePort = await getFreeTcpPort()
  const workerPortBase = await getFreeTcpPortInRange(20000, 59000)
  const loginShellPath = await getLoginShellPath()
  const nvmNodeBinPaths = getNvmNodeBinPaths()
  const runtimePath = mergePathEntries(
    dirname(hermesBin()),
    bundledAgentBrowserBin,
    bundledNodeBin,
    bundledGitPath,
    loginShellPath,
    nvmNodeBinPaths,
    process.env.PATH,
    process.env.Path,
    COMMON_USER_BIN_DIRS.join(delimiter),
  )
  const browserExecutable = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || bundledBrowserExecutable()
  const gitBin = bundledGit()

  // Run via Electron's "run as Node" mode — Electron binary doubles as Node.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HERMES_DESKTOP: 'true',
    HERMES_BIN: hermesBin(),
    // The bridge and its per-profile workers need working stdout/stderr for
    // ready handshakes. Use python.exe on Windows and hide windows at the
    // process creation layer instead of switching the bridge to pythonw.exe.
    HERMES_AGENT_BRIDGE_PYTHON: bundledPython,
    HERMES_AGENT_CLI_PYTHON: bundledPython,
    HERMES_AGENT_ROOT: pythonDir(),
    HERMES_AGENT_NODE: bundledNode(),
    HERMES_AGENT_NODE_ROOT: isWin ? bundledNodeBin : dirname(bundledNodeBin),
    AGENT_BROWSER_HOME: process.env.AGENT_BROWSER_HOME?.trim() || join(agentHome, 'agent-browser'),
    ...(browserExecutable ? { AGENT_BROWSER_EXECUTABLE_PATH: browserExecutable } : {}),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(pythonDir(), 'ms-playwright'),
    ...(gitBin ? { HERMES_AGENT_GIT: gitBin } : {}),
    // Force TCP loopback for the agent bridge. The default `ipc:///tmp/...`
    // unix socket is rejected on macOS in some EDR/sandbox setups (silent
    // SIGKILL of the bridge child within ~150ms). TCP on 127.0.0.1 works
    // identically and avoids the issue cross-platform.
    HERMES_AGENT_BRIDGE_ENDPOINT: `tcp://127.0.0.1:${bridgePort}`,
    // Desktop opens the UI as soon as the Web UI HTTP server is ready, while
    // the Python bridge starts in the background. Let the first chat/context
    // request wait for broker readiness instead of failing during cold start.
    HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS: process.env.HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS ?? '120000',
    // Force TCP for worker endpoints too (upstream #1106). Same EDR/sandbox
    // reason as above — default ipc:// unix sockets in /tmp get killed.
    HERMES_AGENT_BRIDGE_WORKER_TRANSPORT: 'tcp',
    HERMES_AGENT_BRIDGE_WORKER_PORT_BASE: String(workerPortBase),
    // And for preview-mode bridges spawned by the in-app update controller.
    HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT: 'tcp',
    // Suppress the npm-registry update prompt (upstream #1105). hermes-web-ui
    // is bundled here; users can't `npm i -g` to upgrade, they have to wait
    // for the wrapper app to ship a new release.
    HERMES_WEB_UI_DISABLE_UPDATE_CHECK: 'true',
    // Single-user desktop install: open the gateway's user allowlist by
    // default. Otherwise the gateway silently drops every inbound platform
    // message (DingTalk/Slack/Telegram) with a startup warning. Users can
    // still override by setting GATEWAY_ALLOW_ALL_USERS=false in their
    // HERMES_HOME/.env or by configuring per-platform allowlists.
    GATEWAY_ALLOW_ALL_USERS: process.env.GATEWAY_ALLOW_ALL_USERS ?? 'true',
    // Keep the bundled Hermes Agent, bridge, gateway, and Web UI path helpers
    // on the same data directory. Native Windows uses an existing
    // %LOCALAPPDATA%\hermes or %APPDATA%\hermes; otherwise all platforms keep
    // the standard ~/.hermes layout.
    HERMES_HOME: agentHome,
    HERMES_WEB_UI_HOME: home,
    HERMES_WEBUI_STATE_DIR: home,
    AUTH_TOKEN: token,
    PORT: String(port),
    // Prepend bundled Python's bin to PATH so any incidental `python` resolution lands on ours
    PATH: runtimePath,
  }

  serverProc = spawn(process.execPath, [entry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const bridgeStartup = createAgentBridgeStartupTracker()

  serverProc.stdout?.on('data', (chunk: Buffer) => {
    bridgeStartup.observe(chunk)
    process.stdout.write(`[webui] ${chunk}`)
  })
  serverProc.stderr?.on('data', (chunk: Buffer) => {
    bridgeStartup.observe(chunk)
    process.stderr.write(`[webui] ${chunk}`)
  })
  serverProc.on('exit', (code, signal) => {
    console.error(`[webui] server exited code=${code} signal=${signal}`)
    serverProc = null
    if (!app.isReady() || code !== 0) {
      // Best-effort: if server dies abnormally during startup, surface to user
    }
  })

  const timeoutMs = readyTimeoutMs()
  await Promise.all([
    waitForReady(port, timeoutMs),
    bridgeStartup.wait(timeoutMs),
  ])
  return getServerUrl(port)
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/api/health`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok || res.status === 401) return // 401 = up but auth-gated, server is alive
    } catch {
      /* not ready yet */
    }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Web UI server did not become ready within ${timeoutMs}ms`)
}

export function stopWebUiServer(): Promise<void> {
  return new Promise(resolve => {
    if (!serverProc || serverProc.killed) return resolve()
    const proc = serverProc
    const timer = setTimeout(() => {
      killProcessTree(proc)
      resolve()
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { proc.kill('SIGTERM') } catch { resolve() }
  })
}
