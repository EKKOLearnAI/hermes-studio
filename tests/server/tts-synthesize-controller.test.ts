import { beforeEach, describe, expect, it, vi } from 'vitest'

function createMockCtx(body: Record<string, any> = {}) {
  const headers: Record<string, string> = {}
  let closeHandler: (() => void) | undefined

  const ctx: any = {
    request: { body },
    req: {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'close') {
          closeHandler = handler
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
    emitClose() {
      closeHandler?.()
    },
  }
}

describe('getTtsProvider', () => {
  it('returns expected providers and undefined for unknown ids', async () => {
    const { getTtsProvider } = await import('../../packages/server/src/services/hermes/tts-providers')
    const { edgeTtsProvider } = await import('../../packages/server/src/services/hermes/tts-providers/edge')
    const { openaiTtsProvider } = await import('../../packages/server/src/services/hermes/tts-providers/openai')
    const { mimoTtsProvider } = await import('../../packages/server/src/services/hermes/tts-providers/mimo')

    expect(getTtsProvider('edge')).toBe(edgeTtsProvider)
    expect(getTtsProvider('openai')).toBe(openaiTtsProvider)
    expect(getTtsProvider('custom')).toBe(openaiTtsProvider)
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

  it('aborts the provider signal when the request closes', async () => {
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
    const { ctx, emitClose } = createMockCtx({ provider: 'mimo', text: 'Hello world' })

    const pending = ctrl.synthesize(ctx)

    expect(ctx.req.on).toHaveBeenCalledWith('close', expect.any(Function))
    expect(capturedSignal?.aborted).toBe(false)

    emitClose()

    expect(capturedSignal?.aborted).toBe(true)

    resolveSynthesize?.()
    await pending
  })
})

describe('tts routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/routes/hermes/tts')
    vi.doUnmock('../../packages/server/src/controllers/hermes/tts')
  })

  it('registers the synthesize route and keeps the existing routes', async () => {
    const generate = vi.fn(async (ctx: any) => { ctx.body = { route: 'generate' } })
    const openaiProxy = vi.fn(async (ctx: any) => { ctx.body = { route: 'openaiProxy' } })
    const synthesize = vi.fn(async (ctx: any) => { ctx.body = { route: 'synthesize' } })

    vi.doMock('../../packages/server/src/controllers/hermes/tts', () => ({
      generate,
      openaiProxy,
      synthesize,
    }))

    const { ttsRoutes } = await import('../../packages/server/src/routes/hermes/tts')
    const paths = ttsRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/tts',
      '/api/hermes/tts/synthesize',
      '/api/tts/proxy/audio/speech',
    ]))

    const synthLayer: any = ttsRoutes.stack.find((entry: any) => entry.path === '/api/hermes/tts/synthesize')
    const ctx: any = { request: { body: {} }, body: null }

    await synthLayer.stack[0](ctx, undefined)

    expect(synthesize).toHaveBeenCalledWith(ctx, undefined)
    expect(ctx.body).toEqual({ route: 'synthesize' })
  })
})
