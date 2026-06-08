import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('stt settings controller', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  async function initController() {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    return await import('../../packages/server/src/controllers/hermes/stt')
  }

  function makeCtx(user: any | null, body: any = {}, params: Record<string, string> = {}, query: Record<string, string> = {}) {
    return {
      state: user ? { user } : {},
      request: { body },
      params,
      query,
      status: 200,
      body: null,
      set: vi.fn(),
      get: vi.fn(() => ''),
    } as any
  }

  it('saves masked settings rows and lists them for the authenticated user without leaking secrets', async () => {
    const ctrl = await initController()
    const user = { id: 9, username: 'alice', role: 'admin' }

    const saveCtx = makeCtx(user, {
      settings: {
        model: 'gpt-4o-transcribe',
        language: 'en',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    }, { provider: 'openai' })

    await ctrl.saveSettings(saveCtx)

    expect(saveCtx.status).toBe(200)
    expect(saveCtx.body.setting).toMatchObject({
      provider: 'openai',
      settings: {
        model: 'gpt-4o-transcribe',
        language: 'en',
      },
      secrets: {
        apiKey: '[stored]',
      },
    })
    expect(JSON.stringify(saveCtx.body)).not.toContain('server-secret')

    const listCtx = makeCtx(user)
    await ctrl.listSettings(listCtx)

    expect(listCtx.status).toBe(200)
    expect(listCtx.body).toEqual({
      settings: [saveCtx.body.setting],
      activeProvider: 'openai',
    })
    expect(JSON.stringify(listCtx.body)).not.toContain('server-secret')
  })

  it('deletes stored secrets while keeping the settings row masked', async () => {
    const ctrl = await initController()
    const user = { id: 7, username: 'bob', role: 'admin' }

    const saveCtx = makeCtx(user, {
      settings: {
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    }, { provider: 'openai' })
    await ctrl.saveSettings(saveCtx)

    const deleteCtx = makeCtx(user, {}, { provider: 'openai', secretName: 'apiKey' })
    await ctrl.deleteSecret(deleteCtx)

    expect(deleteCtx.status).toBe(200)
    expect(deleteCtx.body).toEqual({
      success: true,
      setting: expect.objectContaining({
        provider: 'openai',
        settings: {
          model: 'gpt-4o-transcribe',
        },
        secrets: {},
      }),
    })
    expect(JSON.stringify(deleteCtx.body)).not.toContain('server-secret')

    const listCtx = makeCtx(user)
    await ctrl.listSettings(listCtx)
    expect(listCtx.body).toEqual({
      settings: [deleteCtx.body.setting],
      activeProvider: 'openai',
    })
  })

  it('deletes saved custom base URL presets without deleting the current setting or secret', async () => {
    const ctrl = await initController()
    const user = { id: 13, username: 'dana', role: 'admin' }

    const saveFirstCtx = makeCtx(user, {
      settings: {
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'whisper-large-v3-turbo',
      },
      secrets: { apiKey: 'server-secret' },
    }, { provider: 'custom' })
    await ctrl.saveSettings(saveFirstCtx)

    const saveSecondCtx = makeCtx(user, {
      settings: {
        baseUrl: 'https://stt.example.test/openai/v1',
        model: 'whisper-large-v3-turbo',
      },
    }, { provider: 'custom' })
    await ctrl.saveSettings(saveSecondCtx)
    expect(saveSecondCtx.body.setting.settings.baseUrlPresets).toEqual([
      'https://stt.example.test/openai/v1',
      'https://api.groq.com/openai/v1',
    ])

    const deleteCtx = makeCtx(
      user,
      {},
      { provider: 'custom' },
      { url: 'https://api.groq.com/openai/v1' },
    )
    await ctrl.deleteBaseUrlPreset(deleteCtx)

    expect(deleteCtx.status).toBe(200)
    expect(deleteCtx.body.setting).toMatchObject({
      provider: 'custom',
      settings: {
        baseUrl: 'https://stt.example.test/openai/v1',
        baseUrlPresets: ['https://stt.example.test/openai/v1'],
        model: 'whisper-large-v3-turbo',
      },
      secrets: { apiKey: '[stored]' },
    })
    expect(JSON.stringify(deleteCtx.body)).not.toContain('server-secret')

    const deleteCurrentCtx = makeCtx(
      user,
      {},
      { provider: 'custom' },
      { url: 'https://stt.example.test/openai/v1' },
    )
    await ctrl.deleteBaseUrlPreset(deleteCurrentCtx)

    expect(deleteCurrentCtx.status).toBe(200)
    expect(deleteCurrentCtx.body.setting).toMatchObject({
      provider: 'custom',
      settings: {
        model: 'whisper-large-v3-turbo',
      },
      secrets: { apiKey: '[stored]' },
    })
    expect(deleteCurrentCtx.body.setting.settings.baseUrl).toBeUndefined()
    expect(deleteCurrentCtx.body.setting.settings.baseUrlPresets).toBeUndefined()
  })

  it('rejects unauthenticated requests and invalid provider inputs', async () => {
    const ctrl = await initController()

    const listCtx = makeCtx(null)
    await ctrl.listSettings(listCtx)
    expect(listCtx.status).toBe(401)
    expect(listCtx.body).toEqual({ error: 'Unauthorized' })

    const saveCtx = makeCtx(null, {}, { provider: 'openai' })
    await ctrl.saveSettings(saveCtx)
    expect(saveCtx.status).toBe(401)
    expect(saveCtx.body).toEqual({ error: 'Unauthorized' })

    const deletePresetCtx = makeCtx(null, {}, { provider: 'custom' }, { url: 'https://api.groq.com/openai/v1' })
    await ctrl.deleteBaseUrlPreset(deletePresetCtx)
    expect(deletePresetCtx.status).toBe(401)
    expect(deletePresetCtx.body).toEqual({ error: 'Unauthorized' })

    const deleteCtx = makeCtx(null, {}, { provider: 'openai', secretName: 'apiKey' })
    await ctrl.deleteSecret(deleteCtx)
    expect(deleteCtx.status).toBe(401)
    expect(deleteCtx.body).toEqual({ error: 'Unauthorized' })

    const authedUser = { id: 4, username: 'eve', role: 'admin' }
    const badProviderCtx = makeCtx(authedUser, {}, { provider: 'nope' })
    await ctrl.saveSettings(badProviderCtx)
    expect(badProviderCtx.status).toBe(400)
    expect(badProviderCtx.body).toEqual({ error: 'unknown STT provider' })

    const badSecretCtx = makeCtx(authedUser, {}, { provider: 'openai', secretName: 'token' })
    await ctrl.deleteSecret(badSecretCtx)
    expect(badSecretCtx.status).toBe(400)
    expect(badSecretCtx.body).toEqual({ error: 'unknown STT provider secret' })

    const badActiveCtx = makeCtx(authedUser, { provider: 'nope' })
    await ctrl.saveActiveProvider(badActiveCtx)
    expect(badActiveCtx.status).toBe(400)
    expect(badActiveCtx.body).toEqual({ error: 'unknown STT provider' })
  })

  it('saves browser as the active STT provider without creating a provider-secret row', async () => {
    const ctrl = await initController()
    const user = { id: 11, username: 'carol', role: 'admin' }

    const ctx = makeCtx(user, { provider: 'browser' })
    await ctrl.saveActiveProvider(ctx)
    expect(ctx.body).toEqual({ activeProvider: 'browser' })

    const listCtx = makeCtx(user)
    await ctrl.listSettings(listCtx)
    expect(listCtx.body).toEqual({ settings: [], activeProvider: 'browser' })
  })
})

describe('stt routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/routes/hermes/stt')
    vi.doUnmock('../../packages/server/src/controllers/hermes/stt')
  })

  it('registers the protected STT settings and transcribe routes', async () => {
    const listSettings = vi.fn(async (ctx: any) => { ctx.body = { route: 'listSettings' } })
    const saveActiveProvider = vi.fn(async (ctx: any) => { ctx.body = { route: 'saveActiveProvider' } })
    const saveSettings = vi.fn(async (ctx: any) => { ctx.body = { route: 'saveSettings' } })
    const deleteSecret = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteSecret' } })
    const deleteBaseUrlPreset = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteBaseUrlPreset' } })
    const transcribe = vi.fn(async (ctx: any) => { ctx.body = { route: 'transcribe' } })

    vi.doMock('../../packages/server/src/controllers/hermes/stt', () => ({
      listSettings,
      saveActiveProvider,
      saveSettings,
      deleteSecret,
      deleteBaseUrlPreset,
      transcribe,
    }))

    const { sttProtectedRoutes } = await import('../../packages/server/src/routes/hermes/stt')
    const protectedPaths = sttProtectedRoutes.stack.map((entry: any) => entry.path)

    expect(protectedPaths).toEqual(expect.arrayContaining([
      '/api/hermes/stt/settings',
      '/api/hermes/stt/settings/active',
      '/api/hermes/stt/settings/:provider',
      '/api/hermes/stt/settings/:provider/base-url-preset',
      '/api/hermes/stt/settings/:provider/secret/:secretName',
      '/api/hermes/stt/transcribe',
    ]))

    const transcribeLayer: any = sttProtectedRoutes.stack.find((entry: any) => entry.path === '/api/hermes/stt/transcribe')
    const ctx: any = { request: { body: {} }, body: null }

    await transcribeLayer.stack[0](ctx, undefined)

    expect(transcribe).toHaveBeenCalledWith(ctx, undefined)
    expect(ctx.body).toEqual({ route: 'transcribe' })
  })
})
