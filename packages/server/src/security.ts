import type { Context, Middleware } from 'koa'
import type { IncomingMessage } from 'http'

interface CorsPolicy {
  allowAll: boolean
  allowedOrigins: Set<string>
}

function normalizeOrigin(origin: string | undefined | null): string | null {
  const value = String(origin || '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function normalizeHost(host: string | undefined | null): string {
  return String(host || '').trim().toLowerCase()
}

function parseCorsPolicy(corsOrigins: string | undefined): CorsPolicy {
  const value = String(corsOrigins || '').trim()
  if (!value) return { allowAll: false, allowedOrigins: new Set() }

  const tokens = value.split(/[\s,]+/).map(token => token.trim()).filter(Boolean)
  if (tokens.includes('*')) return { allowAll: true, allowedOrigins: new Set() }

  const allowedOrigins = new Set<string>()
  for (const token of tokens) {
    const normalized = normalizeOrigin(token)
    if (normalized) allowedOrigins.add(normalized)
  }
  return { allowAll: false, allowedOrigins }
}

function isSameHostOrigin(origin: string, host: string): boolean {
  const requestHost = normalizeHost(host)
  if (!requestHost) return false
  try {
    const parsed = new URL(origin)
    return parsed.host.toLowerCase() === requestHost
  } catch {
    return false
  }
}

export function isOriginAllowed(origin: string | undefined | null, host: string | undefined | null, corsOrigins = ''): boolean {
  const originValue = String(origin || '').trim()
  if (!originValue) return true

  const policy = parseCorsPolicy(corsOrigins)
  const normalizedOrigin = normalizeOrigin(originValue)
  if (!normalizedOrigin) return policy.allowAll

  if (policy.allowAll) return true
  if (policy.allowedOrigins.has(normalizedOrigin)) return true
  return isSameHostOrigin(normalizedOrigin, String(host || ''))
}

export function createCorsOriginResolver(corsOrigins = '') {
  return async (ctx: Context): Promise<string> => {
    const origin = ctx.get('Origin')
    if (!origin) return ''
    if (!isOriginAllowed(origin, ctx.host, corsOrigins)) return ''
    return normalizeOrigin(origin) || ''
  }
}

export function createSocketIoCorsOrigin(corsOrigins = '') {
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void => {
    if (!origin) {
      callback(null, true)
      return
    }
    callback(null, isOriginAllowed(origin, '', corsOrigins))
  }
}

export function shouldRejectUpgradeOrigin(req: IncomingMessage, corsOrigins = ''): boolean {
  const origin = req.headers.origin
  if (!origin) return false
  return !isOriginAllowed(Array.isArray(origin) ? origin[0] : origin, req.headers.host, corsOrigins)
}

export function writeForbiddenOrigin(socket: { write: (chunk: string) => void; destroy: () => void }): void {
  socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
  socket.destroy()
}

function isHttpsRequest(ctx: Context): boolean {
  if (ctx.secure) return true
  const forwardedProto = ctx.get('x-forwarded-proto').split(',')[0]?.trim().toLowerCase()
  return forwardedProto === 'https'
}

export function securityHeaders(): Middleware {
  return async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.set('X-Frame-Options', 'DENY')
    ctx.set('Referrer-Policy', 'no-referrer')
    ctx.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
    ctx.set('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      "connect-src 'self' http: https: ws: wss:",
      "form-action 'self'",
    ].join('; '))

    if (isHttpsRequest(ctx)) {
      ctx.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }

    await next()
  }
}
