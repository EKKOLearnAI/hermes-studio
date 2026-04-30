import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock config
vi.mock('../../packages/server/src/config', () => ({
  config: { upstream: 'http://127.0.0.1:8642' },
}))

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => null,
}))

// Mock updateUsage so we can assert calls without real DB
const { mockUpdateUsage } = vi.hoisted(() => ({
  mockUpdateUsage: vi.fn(),
}))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: mockUpdateUsage,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { proxy, setRunSession } from '../../packages/server/src/routes/hermes/proxy-handler'

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

/**
 * Helper: create a ReadableStream from string chunks.
 * Each chunk is a Uint8Array segment delivered sequentially.
 */
function createSSEBody(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let idx = 0
  return new ReadableStream({
    pull(controller) {
      if (idx < events.length) {
        controller.enqueue(encoder.encode(events[idx]))
        idx++
      } else {
        controller.close()
      }
    },
  })
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

describe('POST /v1/runs — session_id capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('captures run_id → session_id mapping from POST /v1/runs', async () => {
    const runId = 'run-abc-123'
    const sessionId = 'session-xyz'
    const responseBody = JSON.stringify({ run_id: runId, status: 'queued' })

    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(responseBody),
      body: null,
    })

    const ctx = createMockCtx({
      path: '/api/hermes/v1/runs',
      req: { method: 'POST' },
      request: {
        body: { session_id: sessionId, input: 'hello', model: 'gpt-4' },
      },
    })

    await proxy(ctx)

    // Verify the response was forwarded to client
    expect(ctx.res.write).toHaveBeenCalledWith(responseBody)
    expect(ctx.res.end).toHaveBeenCalled()
  })

  it('falls through to normal stream when POST body has no session_id', async () => {
    const responseBody = JSON.stringify({ run_id: 'r1', status: 'queued' })
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(responseBody),
      body: null,
    })

    const ctx = createMockCtx({
      path: '/api/hermes/v1/runs',
      req: { method: 'POST' },
      request: { body: { input: 'hello' } }, // no session_id
    })

    await proxy(ctx)

    // Should still forward the response
    expect(ctx.res.end).toHaveBeenCalled()
  })

  it('serializes parsed JSON body when rawBody is not available', async () => {
    const responseBody = JSON.stringify({ run_id: 'r1', status: 'queued' })
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => {
          const encoder = new TextEncoder()
          let done = false
          return {
            read: () => {
              if (done) return Promise.resolve({ done: true, value: undefined })
              done = true
              return Promise.resolve({ done: false, value: encoder.encode(responseBody) })
            },
          }
        },
      },
    })

    const ctx = createMockCtx({
      path: '/api/hermes/v1/runs',
      req: { method: 'POST' },
      request: { body: { session_id: 's1', input: 'test' } },
    })

    await proxy(ctx)

    // Verify fetch was called with stringified body
    const [, options] = mockFetch.mock.calls[0]
    expect(typeof options.body).toBe('string')
    const parsed = JSON.parse(options.body)
    expect(parsed.session_id).toBe('s1')
    expect(parsed.input).toBe('test')
  })
})

describe('SSE stream interception — run.completed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('intercepts run.completed and calls updateUsage', async () => {
    const runId = 'run-test-1'
    const sessionId = 'session-test-1'

    // Pre-populate the run → session mapping
    setRunSession(runId, sessionId)

    const sseData = [
      `data: ${JSON.stringify({ event: 'run.started', run_id: runId })}\n\n`,
      `data: ${JSON.stringify({ event: 'message.delta', run_id: runId, delta: 'Hello' })}\n\n`,
      `data: ${JSON.stringify({ event: 'run.completed', run_id: runId, usage: { input_tokens: 13949, output_tokens: 45, total_tokens: 13994 } })}\n\n`,
    ]

    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSSEBody(sseData),
    })

    const ctx = createMockCtx({
      path: `/api/hermes/v1/runs/${runId}/events`,
      search: `?token=test&profile=default`,
    })

    await proxy(ctx)

    // Verify updateUsage was called with correct values
    expect(mockUpdateUsage).toHaveBeenCalledWith(sessionId, {
      inputTokens: 13949,
      outputTokens: 45,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
      model: '',
      profile: 'default',
    })
    // Verify SSE data was forwarded to client
    expect(ctx.res.write).toHaveBeenCalled()
    expect(ctx.res.end).toHaveBeenCalled()
  })

  it('does not call updateUsage when no mapping exists', async () => {
    const sseData = [
      `data: ${JSON.stringify({ event: 'run.completed', run_id: 'unknown-run', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } })}\n\n`,
    ]

    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSSEBody(sseData),
    })

    const ctx = createMockCtx({
      path: '/api/hermes/v1/runs/unknown-run/events',
      search: '',
    })

    await proxy(ctx)

    expect(mockUpdateUsage).not.toHaveBeenCalled()
  })

  it('does not call updateUsage for non-run.completed events', async () => {
    const runId = 'run-no-complete'
    setRunSession(runId, 'session-x')

    const sseData = [
      `data: ${JSON.stringify({ event: 'run.started', run_id: runId })}\n\n`,
      `data: ${JSON.stringify({ event: 'message.delta', run_id: runId, delta: 'Hi' })}\n\n`,
      `data: ${JSON.stringify({ event: 'run.failed', run_id: runId, error: 'timeout' })}\n\n`,
    ]

    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSSEBody(sseData),
    })

    const ctx = createMockCtx({
      path: `/api/hermes/v1/runs/${runId}/events`,
      search: '',
    })

    await proxy(ctx)

    expect(mockUpdateUsage).not.toHaveBeenCalled()
  })

  it('handles SSE with multiple events in a single chunk', async () => {
    const runId = 'run-multi'
    setRunSession(runId, 'session-multi')

    // All events in one chunk
    const singleChunk = [
      `data: ${JSON.stringify({ event: 'message.delta', run_id: runId, delta: 'A' })}\n\n`,
      `data: ${JSON.stringify({ event: 'message.delta', run_id: runId, delta: 'B' })}\n\n`,
      `data: ${JSON.stringify({ event: 'run.completed', run_id: runId, usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 } })}\n\n`,
    ].join('')

    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSSEBody([singleChunk]),
    })

    const ctx = createMockCtx({
      path: `/api/hermes/v1/runs/${runId}/events`,
      search: '',
    })

    await proxy(ctx)

    expect(mockUpdateUsage).toHaveBeenCalledWith('session-multi', {
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
      model: '',
      profile: 'default',
    })
  })

  it('handles SSE split across multiple chunks', async () => {
    const runId = 'run-split'
    setRunSession(runId, 'session-split')

    const completedJson = JSON.stringify({ event: 'run.completed', run_id: runId, usage: { input_tokens: 200, output_tokens: 50, total_tokens: 250 } })
    const sseEvent = `data: ${completedJson}\n\n`

    // Split the event across two chunks
    const chunk1 = sseEvent.slice(0, 30)
    const chunk2 = sseEvent.slice(30)

    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSSEBody([chunk1, chunk2]),
    })

    const ctx = createMockCtx({
      path: `/api/hermes/v1/runs/${runId}/events`,
      search: '',
    })

    await proxy(ctx)

    expect(mockUpdateUsage).toHaveBeenCalledWith('session-split', {
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
      model: '',
      profile: 'default',
    })
  })
})
