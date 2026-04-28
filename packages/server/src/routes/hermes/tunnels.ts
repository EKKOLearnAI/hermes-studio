import Router from '@koa/router'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { config } from '../../config'
import { getGatewayManagerInstance as getGatewayManager } from '../../services/gateway-bootstrap'

const execFileAsync = promisify(execFile)

export const tunnelRoutes = new Router()

type TunnelName = 'frontend' | 'backend'

interface TunnelState {
  name: TunnelName
  target_url: string
  running: boolean
  pid?: number
  public_url?: string
  error?: string
  started_at?: string
  updated_at: string
}

type TunnelStateMap = Record<TunnelName, TunnelState>

const TUNNEL_NAMES: TunnelName[] = ['frontend', 'backend']

function getDefaultTarget(name: TunnelName): string {
  if (name === 'frontend') {
    return process.env.FRONTEND_TUNNEL_TARGET || `http://127.0.0.1:${process.env.PORT || '8650'}`
  }

  const manager = getGatewayManager()
  const upstreamRaw = typeof manager?.getUpstream === 'function' ? manager.getUpstream() : ''
  const upstream = String(upstreamRaw || '').replace('://0.0.0.0', '://127.0.0.1')
  return process.env.BACKEND_TUNNEL_TARGET || process.env.UPSTREAM || upstream || 'http://127.0.0.1:8642'
}

const STATE_FILE = join(config.dataDir, 'cloudflare-tunnels.json')
const processes: Partial<Record<TunnelName, ReturnType<typeof spawn>>> = {}

function nowIso(): string {
  return new Date().toISOString()
}

function createDefaultState(name: TunnelName): TunnelState {
  return {
    name,
    target_url: getDefaultTarget(name),
    running: false,
    updated_at: nowIso(),
  }
}

function isTunnelName(value: string): value is TunnelName {
  return value === 'frontend' || value === 'backend'
}

function extractTunnelUrl(line: string): string | null {
  const quickMatch = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
  if (quickMatch) return quickMatch[0]

  const cfMatch = line.match(/https:\/\/[a-z0-9][-a-z0-9.]*(?:\.trycloudflare\.com|\.cfargotunnel\.com)[^\s"<>]*/i)
  if (cfMatch) return cfMatch[0]

  const availMatch = line.match(/(?:tunnel is available at|Visit it at|your tunnel):\s*(https:\/\/\S+)/i)
  if (availMatch) return availMatch[1]

  return null
}

function isPidRunning(pid?: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function loadStateMap(): Promise<TunnelStateMap> {
  const defaults: TunnelStateMap = {
    frontend: createDefaultState('frontend'),
    backend: createDefaultState('backend'),
  }

  try {
    const raw = await readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TunnelStateMap>
    return {
      frontend: { ...defaults.frontend, ...(parsed.frontend || {}), name: 'frontend' },
      backend: { ...defaults.backend, ...(parsed.backend || {}), name: 'backend' },
    }
  } catch {
    return defaults
  }
}

async function saveStateMap(stateMap: TunnelStateMap): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(stateMap, null, 2), 'utf-8')
}

async function patchTunnelState(name: TunnelName, patch: Partial<TunnelState>): Promise<TunnelState> {
  const stateMap = await loadStateMap()
  const current = stateMap[name]
  const next: TunnelState = {
    ...current,
    ...patch,
    name,
    updated_at: nowIso(),
  }
  stateMap[name] = next
  await saveStateMap(stateMap)
  return next
}

async function getTunnelState(name: TunnelName): Promise<TunnelState> {
  const stateMap = await loadStateMap()
  const current = stateMap[name]

  if (current.running && !isPidRunning(current.pid)) {
    const reset: TunnelState = {
      ...current,
      running: false,
      pid: undefined,
      public_url: undefined,
      error: undefined,
      updated_at: nowIso(),
    }
    stateMap[name] = reset
    await saveStateMap(stateMap)
    return reset
  }

  return current
}

async function getAllTunnelStates(): Promise<TunnelStateMap> {
  const frontend = await getTunnelState('frontend')
  const backend = await getTunnelState('backend')
  return { frontend, backend }
}

async function ensureCloudflaredAvailable(): Promise<void> {
  try {
    await execFileAsync('cloudflared', ['--version'], { timeout: 5000 })
  } catch {
    throw new Error('cloudflared not found. Install it first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
  }
}

async function stopTunnel(name: TunnelName): Promise<TunnelState> {
  const child = processes[name]
  if (child && !child.killed) {
    child.kill('SIGTERM')
  }

  const current = await getTunnelState(name)
  if (current.pid && isPidRunning(current.pid)) {
    try {
      process.kill(current.pid, 'SIGTERM')
    } catch {
      // ignore
    }
  }

  delete processes[name]

  return patchTunnelState(name, {
    running: false,
    pid: undefined,
    public_url: undefined,
    error: undefined,
  })
}

async function startTunnel(name: TunnelName, targetUrl?: string): Promise<TunnelState> {
  await ensureCloudflaredAvailable()

  const current = await getTunnelState(name)
  const target = (targetUrl || current.target_url || getDefaultTarget(name)).trim()

  if (current.running) {
    await stopTunnel(name)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  const child = spawn('cloudflared', ['tunnel', '--url', target, '--no-autoupdate'], {
    env: process.env,
  })
  processes[name] = child

  const baseState = await patchTunnelState(name, {
    target_url: target,
    running: true,
    pid: child.pid,
    public_url: undefined,
    error: undefined,
    started_at: nowIso(),
  })

  const onLine = async (raw: string) => {
    const line = raw.trim()
    if (!line) return

    const url = extractTunnelUrl(line)
    if (url) {
      await patchTunnelState(name, {
        running: true,
        pid: child.pid,
        public_url: url,
        error: undefined,
      })
    }
  }

  child.stdout.on('data', (buf) => {
    String(buf)
      .split(/\r?\n/)
      .forEach((line) => {
        void onLine(line)
      })
  })

  child.stderr.on('data', (buf) => {
    String(buf)
      .split(/\r?\n/)
      .forEach((line) => {
        void onLine(line)
      })
  })

  child.on('exit', (code, signal) => {
    delete processes[name]
    void patchTunnelState(name, {
      running: false,
      pid: undefined,
      public_url: undefined,
      error: code && code !== 0 ? `cloudflared exited (code=${code}, signal=${signal || 'none'})` : undefined,
    })
  })

  return baseState
}

async function restartTunnel(name: TunnelName, targetUrl?: string): Promise<TunnelState> {
  await stopTunnel(name)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  return startTunnel(name, targetUrl)
}

function badRequest(ctx: any, message: string) {
  ctx.status = 400
  ctx.body = { error: message }
}

tunnelRoutes.get('/api/hermes/tunnels', async (ctx) => {
  const tunnels = await getAllTunnelStates()
  ctx.body = { tunnels }
})

tunnelRoutes.get('/api/hermes/tunnels/:name', async (ctx) => {
  const name = String(ctx.params.name || '')
  if (!isTunnelName(name)) {
    badRequest(ctx, 'invalid tunnel name')
    return
  }

  const tunnel = await getTunnelState(name)
  ctx.body = { tunnel }
})

tunnelRoutes.post('/api/hermes/tunnels/:name/start', async (ctx) => {
  const name = String(ctx.params.name || '')
  if (!isTunnelName(name)) {
    badRequest(ctx, 'invalid tunnel name')
    return
  }

  try {
    const tunnel = await startTunnel(name, ctx.request.body?.target_url)
    ctx.body = { success: true, tunnel }
  } catch (error: any) {
    await patchTunnelState(name, {
      running: false,
      pid: undefined,
      public_url: undefined,
      error: error?.message || 'failed to start tunnel',
    })
    ctx.status = 500
    ctx.body = { error: error?.message || 'failed to start tunnel' }
  }
})

tunnelRoutes.post('/api/hermes/tunnels/:name/stop', async (ctx) => {
  const name = String(ctx.params.name || '')
  if (!isTunnelName(name)) {
    badRequest(ctx, 'invalid tunnel name')
    return
  }

  const tunnel = await stopTunnel(name)
  ctx.body = { success: true, tunnel }
})

tunnelRoutes.post('/api/hermes/tunnels/:name/restart', async (ctx) => {
  const name = String(ctx.params.name || '')
  if (!isTunnelName(name)) {
    badRequest(ctx, 'invalid tunnel name')
    return
  }

  try {
    const tunnel = await restartTunnel(name, ctx.request.body?.target_url)
    ctx.body = { success: true, tunnel }
  } catch (error: any) {
    await patchTunnelState(name, {
      running: false,
      pid: undefined,
      public_url: undefined,
      error: error?.message || 'failed to restart tunnel',
    })
    ctx.status = 500
    ctx.body = { error: error?.message || 'failed to restart tunnel' }
  }
})
