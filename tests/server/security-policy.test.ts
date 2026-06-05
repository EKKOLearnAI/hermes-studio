import http from 'http'
import Koa from 'koa'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCorsOriginResolver,
  isOriginAllowed,
  securityHeaders,
  shouldRejectUpgradeOrigin,
} from '../../packages/server/src/security'

function fakeCtx(origin: string, host: string) {
  return {
    host,
    get(name: string) {
      return name.toLowerCase() === 'origin' ? origin : ''
    },
  } as any
}

describe('server security policy', () => {
  let servers: http.Server[] = []

  afterEach(async () => {
    const closing = servers.map(server => new Promise<void>((resolve) => server.close(() => resolve())))
    servers = []
    await Promise.all(closing)
  })

  it('allows same-host browser origins without enabling wildcard CORS', async () => {
    const resolveOrigin = createCorsOriginResolver('')

    await expect(resolveOrigin(fakeCtx('http://127.0.0.1:8648', '127.0.0.1:8648'))).resolves.toBe('http://127.0.0.1:8648')
    await expect(resolveOrigin(fakeCtx('https://evil.example', '127.0.0.1:8648'))).resolves.toBe('')
  })

  it('allows configured origins and explicit wildcard opt-in only', () => {
    expect(isOriginAllowed('https://app.example', '127.0.0.1:8648', 'https://app.example')).toBe(true)
    expect(isOriginAllowed('https://evil.example', '127.0.0.1:8648', 'https://app.example')).toBe(false)
    expect(isOriginAllowed('null', '127.0.0.1:8648', '')).toBe(false)
    expect(isOriginAllowed('null', '127.0.0.1:8648', '*')).toBe(true)
    expect(isOriginAllowed('https://evil.example', '127.0.0.1:8648', '*')).toBe(true)
  })

  it('rejects disallowed browser websocket upgrade origins', () => {
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'https://evil.example', host: '127.0.0.1:8648' } } as any, '')).toBe(true)
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'null', host: '127.0.0.1:8648' } } as any, '')).toBe(true)
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'http://127.0.0.1:8648', host: '127.0.0.1:8648' } } as any, '')).toBe(false)
    expect(shouldRejectUpgradeOrigin({ headers: { host: '127.0.0.1:8648' } } as any, '')).toBe(false)
  })

  it('adds baseline browser security headers', async () => {
    const app = new Koa()
    app.use(securityHeaders())
    app.use((ctx) => {
      ctx.body = { ok: true }
    })
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected tcp server')

    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { 'x-forwarded-proto': 'https' },
    })

    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000')
  })
})
