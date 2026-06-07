import { beforeEach, describe, expect, it, vi } from 'vitest'

function createMockCtx(body: Record<string, any> = {}) {
  const headers: Record<string, string> = {}
  let requestAbortHandler: (() => void) | undefined
  let responseCloseHandler: (() => void) | undefined

  const ctx: any = {
    request: { body },
    req: {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'aborted') {
          requestAbortHandler = handler
        }
      }),
    },
    res: {
      writableEnded: false,
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'close') {
          responseCloseHandler = handler
        }
      }),
    },
    status: 200,
    body: undefined,
    set: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
  }

  return {
    ctx,
    headers,
    emitRequestAborted() {
      requestAbortHandler?.()
    },
    emitResponseClose({ writableEnded = false } = {}) {
      ctx.res.writableEnded = writableEnded
      responseCloseHandler?.()
    },
  }
}

describe('getTtsProvider', () => {
  it('returns expected providers and undefined for unknown ids', async () => {
    const { getTtsProvider } = await import('../../packages/server/src/services/hermes/tts-providers')
    const { edgeTtsProvider } = await import('../../packages/server/src/services/hermes/tts-providers/edge')
    const { customTtsProvider, openaiTtsProvider } = await import('../../packages/server/src/services/hermes/tts-providers/openai')
    const { mimoTtsProvider } = await import('../../packages/server/src/services/hermes/tts-providers/mimo')

    expect(getTtsProvider('edge')).toBe(edgeTtsProvider)
    expect(getTtsProvider('openai')).toBe(openaiTtsProvider)
    expect(getTtsProvider('custom')).toBe(customTtsProvider)
    expect(getTtsProvider('mimo')).toBe(mimoTtsProvider)
    expect(getTtsProvider('unknown')).toBeUndefined()
  })
})

describe('tts synthesize controller', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/services/hermes/tts-providers')
    vi.doUnmock('../../packages/server/src/controllers/hermes/tts')
  })

  it('returns 400 for an unknown provider', async () => {
    const getTtsProvider = vi.fn(() => undefined)
    vi.doMock('../../packages/server/src/services/hermes/tts-providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
    const { ctx } = createMockCtx({ provider: 'nope', text: 'hello' })

    await ctrl.synthesize(ctx)

    expect(getTtsProvider).toHaveBeenCalledWith('nope')
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'unknown TTS provider' })
  })

  it('returns 400 for missing or blank text', async () => {
    const provider = { synthesize: vi.fn() }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/services/hermes/tts-providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
    const { ctx } = createMockCtx({ provider: 'mimo', text: '   ' })

    await ctrl.synthesize(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'text is required' })
    expect(provider.synthesize).not.toHaveBeenCalled()
  })

  it('returns 400 when options is not an object', async () => {
    const provider = { synthesize: vi.fn() }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/services/hermes/tts-providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')

    for (const options of ['voice=verse', null, ['verse']]) {
      const { ctx } = createMockCtx({ provider: 'mimo', text: 'hello', options })

      await ctrl.synthesize(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'options must be an object' })
    }

    expect(provider.synthesize).not.toHaveBeenCalled()
  })

  it('calls the provider, returns audio headers, and writes the audio buffer body', async () => {
    const audio = Buffer.from('mimo-audio')
    const provider = {
      synthesize: vi.fn().mockResolvedValue({
        audio,
        contentType: 'audio/wav',
        engine: 'mimo',
        provider: 'mimo',
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/services/hermes/tts-providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
    const { ctx, headers } = createMockCtx({
      provider: 'mimo',
      text: 'Hello world',
      options: { voice: 'verse' },
    })

    await ctrl.synthesize(ctx)

    expect(provider.synthesize).toHaveBeenCalledTimes(1)
    expect(provider.synthesize).toHaveBeenCalledWith(
      {
        text: 'Hello world',
        signal: expect.any(AbortSignal),
      },
      { voice: 'verse' },
    )
    expect(headers).toEqual({
      'Content-Type': 'audio/wav',
      'Content-Length': String(audio.length),
      'X-TTS-Engine': 'mimo',
      'X-TTS-Provider': 'mimo',
    })
    expect(ctx.body).toBe(audio)
  })

  it('aborts the provider signal on client disconnect, but not on normal request close', async () => {
    const audio = Buffer.from('late-audio')
    let capturedSignal: AbortSignal | undefined
    let resolveSynthesize: (() => void) | undefined
    const provider = {
      synthesize: vi.fn().mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
        capturedSignal = signal
        await new Promise<void>((resolve) => {
          resolveSynthesize = resolve
        })
        return {
          audio,
          contentType: 'audio/mpeg',
          engine: 'mimo',
          provider: 'mimo',
        }
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/services/hermes/tts-providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
    const { ctx, emitRequestAborted, emitResponseClose } = createMockCtx({ provider: 'mimo', text: 'Hello world' })

    const pending = ctrl.synthesize(ctx)

    expect(ctx.req.on).toHaveBeenCalledWith('aborted', expect.any(Function))
    expect(ctx.res.on).toHaveBeenCalledWith('close', expect.any(Function))
    expect(capturedSignal?.aborted).toBe(false)

    emitResponseClose({ writableEnded: true })
    expect(capturedSignal?.aborted).toBe(false)

    emitRequestAborted()
    expect(capturedSignal?.aborted).toBe(true)

    resolveSynthesize?.()
    await pending
  })

  it('returns 499 when the provider aborts', async () => {
    const abortError = Object.assign(new Error('client went away'), { name: 'AbortError' })
    const provider = {
      synthesize: vi.fn().mockRejectedValue(abortError),
    }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/services/hermes/tts-providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
    const { ctx } = createMockCtx({ provider: 'mimo', text: 'Hello world' })

    await ctrl.synthesize(ctx)

    expect(ctx.status).toBe(499)
    expect(ctx.body).toEqual({ error: 'TTS request aborted' })
    expect(JSON.stringify(ctx.body)).not.toContain('client went away')
  })

  it('returns sanitized provider details when the provider fails', async () => {
    const provider = {
      synthesize: vi.fn().mockRejectedValue(new Error('MiMo TTS returned 401: apiKey=*** body')),
    }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/services/hermes/tts-providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
    const { ctx } = createMockCtx({ provider: 'mimo', text: 'Hello world' })

    await ctrl.synthesize(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({
      error: 'TTS synthesis failed',
      detail: 'MiMo TTS returned 401: apiKey=[redacted] body',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('***')
  })

  it('probes OpenAI-compatible model endpoints, ranks models, and redacts errors', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { id: 'gpt-4o-mini' },
          { id: 'whisper-large-v3' },
          { id: 'tts-1-hd' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'bad sk-test-secret-value key' } }), { status: 401, statusText: 'Unauthorized' }))
    globalThis.fetch = fetchMock as any
    let safety: typeof import('../../packages/server/src/services/hermes/tts-providers/url-safety') | undefined

    try {
      safety = await import('../../packages/server/src/services/hermes/tts-providers/url-safety')
      safety.setTtsDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 } as any])
      const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
      const { ctx } = createMockCtx({
        kind: 'tts',
        provider: 'custom',
        compatibility: 'openai-compatible',
        baseUrl: 'https://api.example.com/openai/v1/audio/speech/',
        apiKey: 'sk-test-secret-value',
      })
      ctx.state = { user: { id: 1 } }

      await ctrl.probeProvider(ctx)

      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/openai/v1/models', expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-secret-value' }),
      }))
      expect(ctx.body.ok).toBe(true)
      expect(ctx.body.models[0].id).toBe('tts-1-hd')
      expect(ctx.body.recommendedModel).toBe('tts-1-hd')
      expect(ctx.body.normalizedBaseUrl).toBe('https://api.example.com/openai/v1/audio/speech')

      const failed = createMockCtx({
        kind: 'stt',
        provider: 'custom',
        compatibility: 'openai-compatible',
        baseUrl: 'https://api.example.com/openai/v1',
        apiKey: 'sk-test-secret-value',
      })
      failed.ctx.state = { user: { id: 1 } }
      await ctrl.probeProvider(failed.ctx)

      expect(failed.ctx.status).toBe(200)
      expect(failed.ctx.body.ok).toBe(false)
      expect(failed.ctx.body.errorSummary).toContain('Authentication failed')
      expect(JSON.stringify(failed.ctx.body)).not.toContain('sk-test-secret-value')
      expect(failed.ctx.body.manualModelAllowed).toBe(true)
    } finally {
      safety?.resetTtsDnsLookupForTests()
      globalThis.fetch = originalFetch
    }
  })

  it('does not call upstream discovery for manual custom endpoint probes', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
    let safety: typeof import('../../packages/server/src/services/hermes/tts-providers/url-safety') | undefined

    try {
      safety = await import('../../packages/server/src/services/hermes/tts-providers/url-safety')
      safety.setTtsDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 } as any])
      const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
      const { ctx } = createMockCtx({
        kind: 'stt',
        provider: 'custom',
        compatibility: 'manual',
        baseUrl: 'https://manual.example.test/v1/',
        apiKey: 'sk-test-secret-value',
      })
      ctx.state = { user: { id: 1 } }

      await ctrl.probeProvider(ctx)

      expect(fetchMock).not.toHaveBeenCalled()
      expect(ctx.body).toEqual({
        ok: true,
        models: [],
        recommendedModel: '',
        errorSummary: '',
        manualModelAllowed: true,
        normalizedBaseUrl: 'https://manual.example.test/v1',
      })
    } finally {
      safety?.resetTtsDnsLookupForTests()
      globalThis.fetch = originalFetch
    }
  })

  it('blocks local or private network provider probe targets before upstream fetch', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any

    try {
      const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
      const { ctx } = createMockCtx({
        kind: 'tts',
        provider: 'custom',
        compatibility: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: 'sk-tes...alue',
      })
      ctx.state = { user: { id: 1 } }

      await ctrl.probeProvider(ctx)

      expect(fetchMock).not.toHaveBeenCalled()
      expect(ctx.status).toBe(400)
      expect(ctx.body.ok).toBe(false)
      expect(ctx.body.errorSummary).toContain('blocked local or private network')
      expect(JSON.stringify(ctx.body)).not.toContain('sk-tes...alue')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('tts routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/routes/hermes/tts')
    vi.doUnmock('../../packages/server/src/controllers/hermes/tts')
  })

  it('registers public legacy routes separately from the protected synthesize route', async () => {
    const generate = vi.fn(async (ctx: any) => { ctx.body = { route: 'generate' } })
    const openaiProxy = vi.fn(async (ctx: any) => { ctx.body = { route: 'openaiProxy' } })
    const synthesize = vi.fn(async (ctx: any) => { ctx.body = { route: 'synthesize' } })
    const listSettings = vi.fn(async (ctx: any) => { ctx.body = { route: 'listSettings' } })
    const saveSettings = vi.fn(async (ctx: any) => { ctx.body = { route: 'saveSettings' } })
    const deleteBaseUrlPreset = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteBaseUrlPreset' } })
    const deleteSecret = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteSecret' } })
    const probeProvider = vi.fn(async (ctx: any) => { ctx.body = { route: 'probeProvider' } })

    vi.doMock('../../packages/server/src/controllers/hermes/tts', () => ({
      generate,
      openaiProxy,
      synthesize,
      listSettings,
      saveSettings,
      deleteBaseUrlPreset,
      deleteSecret,
      probeProvider,
    }))

    const { ttsRoutes, ttsProtectedRoutes } = await import('../../packages/server/src/routes/hermes/tts')
    const paths = ttsRoutes.stack.map((entry: any) => entry.path)
    const protectedPaths = ttsProtectedRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/tts',
      '/api/tts/proxy/audio/speech',
    ]))
    expect(paths).not.toContain('/api/hermes/tts/synthesize')
    expect(protectedPaths).toEqual(expect.arrayContaining([
      '/api/hermes/tts/settings',
      '/api/hermes/tts/settings/:provider',
      '/api/hermes/tts/settings/:provider/base-url-preset',
      '/api/hermes/tts/settings/:provider/secret/:secretName',
      '/api/voice/providers/probe',
      '/api/hermes/tts/synthesize',
    ]))

    const synthLayer: any = ttsProtectedRoutes.stack.find((entry: any) => entry.path === '/api/hermes/tts/synthesize')
    const ctx: any = { request: { body: {} }, body: null }

    await synthLayer.stack[0](ctx, undefined)

    expect(synthesize).toHaveBeenCalledWith(ctx, undefined)
    expect(ctx.body).toEqual({ route: 'synthesize' })
  })
})

describe('route registration ordering', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/routes/index')
  })

  it('mounts protected synthesize routes after requireAuth', async () => {
    const ttsPublicMiddleware = async () => {}
    const ttsProtectedMiddleware = async () => {}
    const proxyMiddleware = async () => {}

    vi.doMock('../../packages/server/src/routes/hermes/tts', () => ({
      ttsRoutes: { routes: vi.fn(() => ttsPublicMiddleware) },
      ttsProtectedRoutes: { routes: vi.fn(() => ttsProtectedMiddleware) },
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
    expect(mountedMiddleware.indexOf(ttsProtectedMiddleware)).toBeGreaterThan(mountedMiddleware.indexOf(requireAuth))
    expect(returnedProxyMiddleware).toBe(proxyMiddleware)
  })
})
