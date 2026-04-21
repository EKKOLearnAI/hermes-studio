import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock config
vi.mock('../../packages/server/src/config', () => ({
  config: { upstream: 'http://127.0.0.1:8642' },
}))

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => null,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { proxy } from '../../packages/server/src/routes/hermes/proxy-handler'

function createMockCtx(overrides: Record<string, any> = {}) {
  const ctx: any = {
    path: '/api/hermes/jobs',
    method: 'GET',
    headers: { host: 'localhost:8648', 'content-type': 'application/json' },
    query: {},
    search: '',
    req: { method: 'GET' },
    res: {
      write: vi.fn(),
      end: vi.fn(),
      headersSent: false,
      writableEnded: false,
    },
    request: { rawBody: undefined },
    status: 200,
    set: vi.fn(),
    body: null,
    ...overrides,
  }
  ctx.get = (name: string) => {
    const match = Object.entries(ctx.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
    const value = match?.[1]
    return Array.isArray(value) ? value[0] : value || ''
  }
  return ctx
}

describe('Proxy Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rewrites /api/hermes/v1/* to /v1/*', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      json: () => Promise.resolve({ ok: true }),
    })

    const ctx = createMockCtx({ path: '/api/hermes/v1/runs', search: '' })
    await proxy(ctx)

    expect(mockFetch).toHaveBeenCalledOnce()
    const url = mockFetch.mock.calls[0][0]
    expect(url).toContain('/v1/runs')
    expect(url).not.toContain('/api/hermes')
  })

  it('rewrites /api/hermes/* to /api/*', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      json: () => Promise.resolve({ ok: true }),
    })

    const ctx = createMockCtx({ path: '/api/hermes/jobs', search: '' })
    await proxy(ctx)

    const url = mockFetch.mock.calls[0][0]
    expect(url).toContain('/api/jobs')
    expect(url).not.toContain('/api/hermes')
  })

  it('strips authorization header', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      json: () => Promise.resolve({}),
    })

    const ctx = createMockCtx({
      headers: { host: 'localhost:8648', authorization: 'Bearer web-ui-token' },
    })
    await proxy(ctx)

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers.authorization).toBeUndefined()
  })

  it('replaces host header with upstream host', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      json: () => Promise.resolve({}),
    })

    const ctx = createMockCtx()
    await proxy(ctx)

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers.host).toBe('127.0.0.1:8642')
  })

  it('forwards query string while stripping the web-ui token parameter', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: null,
      json: () => Promise.resolve({}),
    })

    const ctx = createMockCtx({ search: '?include_disabled=true&token=web-ui-token&profile=work' })
    await proxy(ctx)

    const url = mockFetch.mock.calls[0][0]
    expect(url).toContain('?include_disabled=true')
    expect(url).toContain('profile=work')
    expect(url).not.toContain('token=')
  })

  it('returns 502 on connection failure', async () => {
    // waitForGatewayReady loops calling fetch(healthUrl) until res.ok or timeout.
    // Return ok:true for health checks so the loop exits immediately (gateway
    // "ready"), then the retry fetch also fails with ECONNREFUSED → 502.
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/health')) {
        return Promise.resolve({ ok: true })
      }
      return Promise.reject(new Error('ECONNREFUSED'))
    })

    const ctx = createMockCtx()
    await proxy(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({ error: { message: 'Proxy error: ECONNREFUSED' } })
  })

  it('passes through non-200 status codes', async () => {
    mockFetch.mockResolvedValue({
      status: 404,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      json: () => Promise.resolve({ error: 'Not found' }),
    })

    const ctx = createMockCtx()
    await proxy(ctx)

    expect(ctx.status).toBe(404)
  })
})
