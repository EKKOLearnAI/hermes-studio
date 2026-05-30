import { ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { dirname, delimiter, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import { webuiServerEntry, webuiDir, hermesBin, webUiHome, tokenFile, pythonDir } from './paths'

const DEFAULT_PORT = 8648
const READY_TIMEOUT_MS = 30_000

let serverProc: ChildProcess | null = null
let cachedToken: string | null = null

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

export function getToken(): string {
  return ensureToken()
}

export function getServerUrl(port = DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}`
}

export async function startWebUiServer(port = DEFAULT_PORT): Promise<string> {
  ensureNativeModules()
  const token = ensureToken()
  const entry = webuiServerEntry()
  if (!existsSync(entry)) {
    throw new Error(`Web UI server entry not found at ${entry}. Run: npm run build:webui`)
  }

  const home = webUiHome()
  mkdirSync(home, { recursive: true })

  // Tell agent-bridge to use the bundled Python directly. Otherwise the
  // bridge auto-detects Python from HERMES_BIN's shebang — which on our
  // setup is a #!/bin/sh wrapper, not a python interpreter, so detection
  // resolves to /bin/sh and the bridge crashes (exit code 2) immediately.
  const isWin = process.platform === 'win32'
  const bundledPython = isWin
    ? join(pythonDir(), 'python.exe')
    : join(pythonDir(), 'bin', 'python3')

  // Run via Electron's "run as Node" mode — Electron binary doubles as Node.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HERMES_BIN: hermesBin(),
    HERMES_AGENT_BRIDGE_PYTHON: bundledPython,
    HERMES_AGENT_ROOT: pythonDir(),
    // Force TCP loopback for the agent bridge. The default `ipc:///tmp/...`
    // unix socket is rejected on macOS in some EDR/sandbox setups (silent
    // SIGKILL of the bridge child within ~150ms). TCP on 127.0.0.1 works
    // identically and avoids the issue cross-platform.
    HERMES_AGENT_BRIDGE_ENDPOINT: 'tcp://127.0.0.1:18765',
    // Force TCP for worker endpoints too (upstream #1106). Same EDR/sandbox
    // reason as above — default ipc:// unix sockets in /tmp get killed.
    HERMES_AGENT_BRIDGE_WORKER_TRANSPORT: 'tcp',
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
    // ~/.hermes/.env or by configuring per-platform allowlists.
    GATEWAY_ALLOW_ALL_USERS: process.env.GATEWAY_ALLOW_ALL_USERS ?? 'true',
    HERMES_WEB_UI_HOME: home,
    AUTH_TOKEN: token,
    PORT: String(port),
    // Prepend bundled Python's bin to PATH so any incidental `python` resolution lands on ours
    PATH: [dirname(hermesBin()), process.env.PATH].filter(Boolean).join(delimiter),
  }

  serverProc = spawn(process.execPath, [entry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProc.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[webui] ${chunk}`)
  })
  serverProc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[webui] ${chunk}`)
  })
  serverProc.on('exit', (code, signal) => {
    console.error(`[webui] server exited code=${code} signal=${signal}`)
    serverProc = null
    if (!app.isReady() || code !== 0) {
      // Best-effort: if server dies abnormally during startup, surface to user
    }
  })

  await waitForReady(port, READY_TIMEOUT_MS)
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
      try { proc.kill('SIGKILL') } catch { /* */ }
      resolve()
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { proc.kill('SIGTERM') } catch { resolve() }
  })
}
