import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() {
      return body
    },
    async text() {
      return JSON.stringify(body)
    },
  }
}

function textResponse(body: string, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 500) >= 200 && (init.status ?? 500) < 300,
    status: init.status ?? 500,
    statusText: init.statusText ?? 'Error',
    async json() {
      return { error: body }
    },
    async text() {
      return body
    },
  }
}

function multipartBody(
  boundary: string,
  parts: Array<{
    name: string
    value: string | Buffer
    filename?: string
    filenameStar?: string
    contentType?: string
  }>,
): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    const filename = part.filename ? `; filename="${part.filename}"` : ''
    const filenameStar = part.filenameStar ? `; filename*=UTF-8''${part.filenameStar}` : ''
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${filename}${filenameStar}\r\n`))
    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`))
    }
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

function getHeader(headers: RequestInit['headers'] | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase())
    return match?.[1]
  }

  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return typeof match?.[1] === 'string' ? match[1] : undefined
}

describe('stt transcribe controller', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const safety = await import('../../packages/server/src/services/hermes/tts-providers/url-safety')
    safety.setTtsDnsLookupForTests(vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as any)
  })

  afterEach(async () => {
    const safety = await import('../../packages/server/src/services/hermes/tts-providers/url-safety')
    safety.resetTtsDnsLookupForTests()
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  async function initControllerAndStore() {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    return {
      ctrl: await import('../../packages/server/src/controllers/hermes/stt'),
      store: await import('../../packages/server/src/db/hermes/stt-settings-store'),
    }
  }

  function makeMultipartCtx(
    user: any | null,
    parts: Array<{ name: string; value: string | Buffer; filename?: string; filenameStar?: string; contentType?: string }>,
  ) {
    const boundary = 'stt-boundary'
    return {
      state: user ? { user } : {},
      request: {},
      req: Readable.from([multipartBody(boundary, parts)]),
      params: {},
      status: 200,
      body: null,
      set: vi.fn(),
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
    } as any
  }

  function makeJsonCtx(user: any | null, provider: string, body: unknown) {
    return {
      state: user ? { user } : {},
      request: { body },
      req: Readable.from([]),
      params: { provider },
      status: 200,
      body: null,
      set: vi.fn(),
      get: vi.fn(() => ''),
    } as any
  }

  it('transcribes multipart audio using the stored secret and ignores client-supplied api keys', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'transcribed text' }))
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting(7, 'openai', {
      settings: {
        model: 'gpt-4o-transcribe',
        language: 'en',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'openai' },
        { name: 'apiKey', value: 'attacker-secret' },
        { name: 'secrets', value: '{"apiKey":"body-secret"}' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      text: 'transcribed text',
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      language: 'en',
    })
    expect(ctx.body.durationMs).toEqual(expect.any(Number))
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
    expect(JSON.stringify(ctx.body)).not.toContain('attacker-secret')
    expect(JSON.stringify(ctx.body)).not.toContain('body-secret')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0] as [string | URL, RequestInit]
    expect(getHeader(init.headers, 'Authorization')).toBe('Bearer server-secret')
    expect(getHeader(init.headers, 'Authorization')).not.toContain('attacker-secret')
    expect(init.body).toBeInstanceOf(FormData)

    const form = init.body as FormData
    expect(form.get('model')).toBe('gpt-4o-transcribe')
    expect(form.get('language')).toBe('en')
  })

  it('masks stored api keys when listing STT settings', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting(7, 'openai', {
      settings: {
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeJsonCtx({ id: 7, username: 'han', role: 'admin' }, 'openai', undefined)
    await ctrl.listSettings(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      settings: [
        expect.objectContaining({
          provider: 'openai',
          secrets: { apiKey: '[stored]' },
        }),
      ],
      activeProvider: null,
    })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
  })

  it('returns 400 when multipart audio is missing', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting(7, 'openai', {
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: 'server-secret' },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [{ name: 'provider', value: 'openai' }],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'audio is required' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed multipart filename* without throwing', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting(7, 'openai', {
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: 'server-secret' },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'openai' },
        {
          name: 'audio',
          value: Buffer.from('audio-data'),
          filenameStar: 'bad%ZZname.webm',
          contentType: 'audio/webm',
        },
      ],
    )

    await expect(ctrl.transcribe(ctx)).resolves.toBeUndefined()

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Malformed multipart filename' })
    expect(JSON.stringify(ctx.body)).not.toContain('URIError')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 when no saved STT settings exist for the requested provider', async () => {
    const { ctrl } = await initControllerAndStore()
    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'openai' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'STT settings are required for provider openai' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 for saved custom provider settings missing baseUrl', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting(7, 'custom', {
      settings: {
        model: 'whisper-1',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'custom' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await expect(ctrl.transcribe(ctx)).resolves.toBeUndefined()

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Custom STT baseUrl is required' })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('ignores client-supplied custom baseUrl, apiKey, and headers during transcription', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'custom transcript' }))
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting(7, 'custom', {
      settings: {
        baseUrl: 'https://example.com/v1',
        model: 'whisper-1',
        language: 'fr',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'custom' },
        { name: 'baseUrl', value: 'http://127.0.0.1:8000/v1/audio/transcriptions' },
        { name: 'apiKey', value: 'attacker-secret' },
        { name: 'headers', value: '{"Authorization":"Bearer attacker-secret"}' },
        { name: 'settings', value: '{"baseUrl":"http://169.254.169.254/latest/meta-data"}' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      text: 'custom transcript',
      provider: 'custom',
      model: 'whisper-1',
      language: 'fr',
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string | URL, RequestInit]
    expect(String(url)).toBe('https://example.com/v1/audio/transcriptions')
    expect(getHeader(init.headers, 'Authorization')).toBe('Bearer server-secret')
    expect(getHeader(init.headers, 'Authorization')).not.toContain('attacker-secret')
  })

  it.each([
    'http://10.0.0.1:8000/v1/audio/transcriptions',
    'http://172.16.0.1:8000/v1/audio/transcriptions',
    'http://192.168.1.1:8000/v1/audio/transcriptions',
    'http://127.0.0.1:8000/v1/audio/transcriptions',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8000/v1/audio/transcriptions',
    'http://[fd00::1]:8000/v1/audio/transcriptions',
    'http://[fe90::1]:8000/v1/audio/transcriptions',
  ])('rejects unsafe custom baseUrl %s when saving settings', async (baseUrl) => {
    const { ctrl } = await initControllerAndStore()
    const ctx = makeJsonCtx(
      { id: 7, username: 'han', role: 'admin' },
      'custom',
      {
        settings: {
          baseUrl,
          model: 'whisper-1',
        },
        secrets: {
          apiKey: 'server-secret',
        },
      },
    )

    await ctrl.saveSettings(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({
      error: 'Custom STT TTS baseUrl cannot target localhost or private network addresses',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 502 without leaking secrets when the provider fails', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('upstream rejected bearer server-secret', { status: 401, statusText: 'Unauthorized' }))
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting(7, 'openai', {
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: 'server-secret' },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'openai' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({
      error: 'STT transcription failed: OpenAI-compatible STT returned HTTP 401: upstream rejected bearer [redacted]',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
  })
})

describe('route registration ordering', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/routes/index')
  })

  it('mounts protected STT routes after requireAuth', async () => {
    const ttsPublicMiddleware = async () => {}
    const ttsProtectedMiddleware = async () => {}
    const sttProtectedMiddleware = async () => {}
    const proxyMiddleware = async () => {}

    vi.doMock('../../packages/server/src/routes/hermes/tts', () => ({
      ttsRoutes: { routes: vi.fn(() => ttsPublicMiddleware) },
      ttsProtectedRoutes: { routes: vi.fn(() => ttsProtectedMiddleware) },
    }))
    vi.doMock('../../packages/server/src/routes/hermes/stt', () => ({
      sttProtectedRoutes: { routes: vi.fn(() => sttProtectedMiddleware) },
    }))
    vi.doMock('../../packages/server/src/routes/hermes/proxy', () => ({
      proxyRoutes: { routes: vi.fn(() => async () => {}) },
      proxyMiddleware,
    }))

    const { registerRoutes } = await import('../../packages/server/src/routes/index')
    const use = vi.fn()
    const app = { use }
    const requireAuth = vi.fn(async () => {})

    const returnedProxyMiddleware = registerRoutes(app as any, [requireAuth] as any)
    const mountedMiddleware = use.mock.calls.map(([middleware]) => middleware)

    expect(mountedMiddleware.indexOf(ttsPublicMiddleware)).toBeGreaterThanOrEqual(0)
    expect(mountedMiddleware.indexOf(requireAuth)).toBeGreaterThan(mountedMiddleware.indexOf(ttsPublicMiddleware))
    expect(mountedMiddleware.indexOf(sttProtectedMiddleware)).toBeGreaterThan(mountedMiddleware.indexOf(requireAuth))
    expect(mountedMiddleware.indexOf(sttProtectedMiddleware)).toBeGreaterThan(mountedMiddleware.indexOf(ttsProtectedMiddleware))
    expect(returnedProxyMiddleware).toBe(proxyMiddleware)
  })
})
