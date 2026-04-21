import type { Context } from 'koa'
import { config } from '../../config'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'

function getGatewayManager() { return getGatewayManagerInstance() }

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

/** Resolve profile name from request */
function resolveProfile(ctx: Context): string {
  return ctx.get('x-hermes-profile') || (ctx.query.profile as string) || 'default'
}

/** Resolve upstream URL for a request based on profile header/query */
function resolveUpstream(ctx: Context): string {
  const mgr = getGatewayManager()
  if (mgr) {
    const profile = resolveProfile(ctx)
    if (profile && profile !== 'default') {
      return mgr.getUpstream(profile)
    }
    return mgr.getUpstream()
  }
  return config.upstream.replace(/\/$/, '')
}

export async function proxy(ctx: Context) {
  const profile = resolveProfile(ctx)
  const upstream = resolveUpstream(ctx)
  // Rewrite path for upstream gateway:
  //   /api/hermes/v1/* -> /v1/*  (upstream uses /v1/ prefix)
  //   /api/hermes/*     -> /api/* (upstream uses /api/ prefix)
  const upstreamPath = ctx.path.replace(/^\/api\/hermes\/v1/, '/v1').replace(/^\/api\/hermes/, '/api')
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  // Build headers — forward most, strip browser/web-ui specific ones
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

  // Inject Hermes gateway API key from profile's .env
  const mgr = getGatewayManager()
  if (mgr) {
    const apiKey = mgr.getApiKey(profile)
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`
    }
  }

  try {
    // Build request body from raw body
    let body: string | undefined
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      body = (ctx as any).request.rawBody as string | undefined
    }

    const requestInit: RequestInit = {
      method: ctx.req.method,
      headers,
      body,
    }

    let res: Response
    try {
      res = await fetch(url, requestInit)
    } catch (err: any) {
      // Gateway may be restarting; wait briefly and retry once.
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

    // Stream response body
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
