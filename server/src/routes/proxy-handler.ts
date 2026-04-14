import type { Context } from 'koa'
import { config } from '../config'

export async function proxy(ctx: Context) {
  const upstream = config.upstream.replace(/\/$/, '')
  const url = `${upstream}${ctx.path}${ctx.search || ''}`
  console.log(`[PROXY] ${ctx.method} ${ctx.path} -> ${url}`)

  // Build headers — forward most, strip browser-specific ones
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (value == null) continue
    const lower = key.toLowerCase()
    if (lower === 'host') {
      headers['host'] = new URL(upstream).host
    } else if (lower !== 'origin' && lower !== 'referer' && lower !== 'connection') {
      const v = Array.isArray(value) ? value[0] : value
      if (v) headers[key] = v
    }
  }

  // Add SSE-friendly headers
  if (ctx.path.match(/\/events$/)) {
    headers['x-accel-buffering'] = 'no'
    headers['cache-control'] = 'no-cache'
  }

  // Auto-inject upstream API key if configured and not already present
  if (!headers['authorization'] && !headers['Authorization'] && config.upstreamApiKey) {
    headers['Authorization'] = `Bearer ${config.upstreamApiKey}`
  }

  try {
    // Build request body from raw body
    let body: string | undefined
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      body = (ctx as any).request.rawBody as string | undefined
    }

    const res = await fetch(url, {
      method: ctx.req.method,
      headers,
      body,
    })

    // Set response headers
    const resHeaders: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower !== 'transfer-encoding' && lower !== 'connection') {
        resHeaders[key] = value
      }
    })
    if (ctx.path.match(/\/events$/)) {
      resHeaders['x-accel-buffering'] = 'no'
      resHeaders['cache-control'] = 'no-cache'
    }

    ctx.status = res.status
    ctx.set(resHeaders)

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
