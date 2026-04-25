import type { Context } from 'koa'
import { config } from '../../config'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { updateUsage } from '../../db/hermes/usage-store'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'

function getGatewayManager() { return getGatewayManagerInstance() }

// --- run_id → session_id mapping (in-memory, ephemeral) ---

const runSessionMap = new Map<string, string>()

export function setRunSession(runId: string, sessionId: string): void {
  runSessionMap.set(runId, sessionId)
  // Auto-cleanup after 30 minutes
  setTimeout(() => runSessionMap.delete(runId), 30 * 60 * 1000)
}

function getSessionForRun(runId: string): string | undefined {
  return runSessionMap.get(runId)
}

// --- Profile backend_url resolution ---

const HERMES_BASE = join(homedir(), '.hermes')

/** Read backend config from a profile's config.yaml. Exported for use by sessions controller. */
export function readProfileBackendUrl(profileName: string): { url: string; token: string; bff_url: string; bff_token: string } {
  const configPath = profileName === 'default'
    ? join(HERMES_BASE, 'config.yaml')
    : join(HERMES_BASE, 'profiles', profileName, 'config.yaml')
  if (!existsSync(configPath)) return { url: '', token: '', bff_url: '', bff_token: '' }
  try {
    const content = readFileSync(configPath, 'utf-8')
    const cfg = yaml.load(content) as any || {}
    const url = cfg?.backend?.url?.trim() || ''
    const token = cfg?.backend?.token?.trim() || ''
    const bff_url = cfg?.backend?.bff_url?.trim() || ''
    const bff_token = cfg?.backend?.bff_token?.trim() || ''
    return { url, token, bff_url, bff_token }
  } catch {
    return { url: '', token: '', bff_url: '', bff_token: '' }
  }
}

/** Normalize profile name to match actual directory name (case-insensitive). Exported for sessions controller. */
export function normalizeProfileName(name: string): string {
  if (name === 'default') return name
  const exactDir = join(HERMES_BASE, 'profiles', name)
  if (existsSync(exactDir)) return name
  const lower = name.toLowerCase()
  const lowerDir = join(HERMES_BASE, 'profiles', lower)
  if (existsSync(lowerDir)) return lower
  return name
}

/** Resolve profile name from request (normalizes to match actual directory name) */
function resolveProfile(ctx: Context): string {
  const raw = ctx.get('x-hermes-profile') || (ctx.query.profile as string) || 'default'
  return normalizeProfileName(raw)
}

/** Resolve upstream URL for a request based on profile header/query */
function resolveUpstream(ctx: Context): string {
  const profile = resolveProfile(ctx)

  // 1. Check profile's backend.url (remote backend configured in config.yaml)
  const { url: backendUrl } = readProfileBackendUrl(profile)
  if (backendUrl) return backendUrl.replace(/\/$/, '')

  // 2. Fall back to GatewayManager (local gateway)
  const mgr = getGatewayManager()
  if (mgr) {
    if (profile && profile !== 'default') {
      return mgr.getUpstream(profile)
    }
    return mgr.getUpstream()
  }

  // 3. Default upstream
  return config.upstream.replace(/\/$/, '')
}

// --- Helpers ---

function isTransientGatewayError(err: any): boolean {
  const msg = String(err?.message || '')
  const causeCode = String(err?.cause?.code || '')
  return (
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNRESET' ||
    /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(msg)
  )
}

async function waitForGatewayReady(upstream: string, timeoutMs: number = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `${upstream}/health`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(1200),
      })
      if (res.ok) return true
    } catch { }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}



function buildProxyHeaders(ctx: Context, upstream: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (value == null) continue
    const lower = key.toLowerCase()
    if (lower === 'host') {
      headers['host'] = new URL(upstream).host
    } else if (lower === 'origin' || lower === 'referer' || lower === 'connection' || lower === 'authorization') {
      continue
    } else {
      const v = Array.isArray(value) ? value[0] : value
      if (v) headers[key] = v
    }
  }

  const profile = resolveProfile(ctx)
  const mgr = getGatewayManager()
  if (mgr) {
    const apiKey = mgr.getApiKey(profile)
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`
    }
  }

  // Fall back to profile's backend.token for remote backends
  if (!headers['authorization']) {
    const { token } = readProfileBackendUrl(profile)
    if (token) {
      headers['authorization'] = `Bearer ${token}`
    }
  }

  return headers
}

// --- SSE stream interception ---

const SSE_EVENTS_PATH = /^\/v1\/runs\/([^/]+)\/events$/

/**
 * Parse SSE text chunks and extract run.completed events.
 * Returns the run_id if a run.completed was found.
 */
function extractRunCompletedFromChunk(chunk: string): string | null {
  // SSE format: each line is "data: {...}\n\n"
  const lines = chunk.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.slice(6))
      if (data.event === 'run.completed' && data.usage && data.run_id) {
        const sessionId = getSessionForRun(data.run_id)
        if (sessionId) {
          updateUsage(sessionId, data.usage.input_tokens, data.usage.output_tokens)
          return data.run_id
        }
      }
    } catch { /* not JSON, skip */ }
  }
  return null
}

/**
 * Stream an SSE response while intercepting run.completed events.
 */
async function streamSSE(ctx: Context, res: Response): Promise<void> {
  if (!res.body) {
    ctx.res.end()
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      // Forward raw bytes to client immediately
      ctx.res.write(value)

      // Also decode for interception
      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE lines (delimited by double newline)
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 2)
        extractRunCompletedFromChunk(eventBlock)
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      extractRunCompletedFromChunk(buffer)
    }
  } finally {
    ctx.res.end()
  }
}

// --- Main proxy function ---

export async function proxy(ctx: Context) {
  const profile = resolveProfile(ctx)
  const upstream = resolveUpstream(ctx)
  const upstreamPath = ctx.path.replace(/^\/api\/hermes\/v1/, '/v1').replace(/^\/api\/hermes/, '/api')
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  const headers = buildProxyHeaders(ctx, upstream)

  try {
    let body: string | undefined
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      // @koa/bodyparser parses JSON into ctx.request.body but doesn't store rawBody
      // by default. Re-serialize the parsed body to get the string form.
      const parsed = (ctx as any).request.body
      if (typeof parsed === 'string') {
        body = parsed
      } else if (parsed && typeof parsed === 'object') {
        body = JSON.stringify(parsed)
      }
    }

    const requestInit: RequestInit = { method: ctx.req.method, headers, body }

    let res: Response
    try {
      res = await fetch(url, requestInit)
    } catch (err: any) {
      if (isTransientGatewayError(err) && await waitForGatewayReady(upstream)) {
        res = await fetch(url, requestInit)
      } else {
        throw err
      }
    }

    // Set response headers
    res.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower !== 'transfer-encoding' && lower !== 'connection') {
        ctx.set(key, value)
      }
    })
    ctx.status = res.status

    // Intercept POST /v1/runs to capture run_id → session_id mapping
    if (ctx.req.method === 'POST' && /\/v1\/runs$/.test(upstreamPath) && body) {
      try {
        const parsed = JSON.parse(body)
        if (parsed.session_id) {
          const resBody = await res.text()
          ctx.res.write(resBody)
          ctx.res.end()

          try {
            const result = JSON.parse(resBody)
            if (result.run_id) {
              setRunSession(result.run_id, parsed.session_id)
            }
          } catch { /* response not JSON, ignore */ }
          return
        }
      } catch { /* body not JSON, fall through to normal stream */ }
      // No session_id in body — fall through to normal response handling below
    }

    // Intercept SSE streams for /v1/runs/{id}/events
    const sseMatch = upstreamPath.match(SSE_EVENTS_PATH)
    if (sseMatch) {
      await streamSSE(ctx, res)
      return
    }

    // Default: pipe response body directly
    if (res.body) {
      const reader = res.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          ctx.res.write(value)
        }
        ctx.res.end()
      }
      await pump()
    } else {
      ctx.res.end()
    }
  } catch (err: any) {
    if (!ctx.res.headersSent) {
      ctx.status = 502
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: { message: `Proxy error: ${err.message}` } }
    } else {
      ctx.res.end()
    }
  }
}
