import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const localModelState = vi.hoisted(() => ({ usable: false, validationError: '' }))
const localStreamMocks = vi.hoisted(() => ({
  create: vi.fn(),
  push: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/voice/config-sync', () => ({
  syncVoiceConfigToHermesProfile: vi.fn(async () => ({ stt: 'synced', tts: 'unchanged' })),
}))

vi.mock('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager', () => ({
  LocalSttStreamSessionError: class LocalSttStreamSessionError extends Error {},
  LOCAL_STT_MODEL_ID: 'test-local-stt-model',
  getLocalSttModelStatus: () => ({
    usable: localModelState.usable,
    validationError: localModelState.validationError,
  }),
  transcribeWithLocalStt: vi.fn(),
  startLocalSttModelDownload: vi.fn(),
  createLocalSttStreamSession: localStreamMocks.create,
  pushLocalSttStreamAudio: localStreamMocks.push,
  finishLocalSttStreamSession: localStreamMocks.finish,
  cancelLocalSttStreamSession: localStreamMocks.cancel,
}))

describe('stt settings controller', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    localModelState.usable = false
    localModelState.validationError = ''
    localStreamMocks.create.mockReset()
    localStreamMocks.push.mockReset()
    localStreamMocks.finish.mockReset()
    localStreamMocks.cancel.mockReset()
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  async function initController() {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    return await import('../../packages/server/src/modules/studio/controllers/stt')
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

    const profileProviderRow = db.prepare(
      'SELECT provider, settings_json, secrets_json FROM stt_profile_provider_settings WHERE profile = ? AND provider = ?'
    ).get('default', 'openai') as { provider: string; settings_json: string; secrets_json: string }
    expect(profileProviderRow.provider).toBe('openai')
    expect(JSON.parse(profileProviderRow.settings_json)).toMatchObject({
      model: 'gpt-4o-transcribe',
      language: 'en',
    })
    expect(JSON.parse(profileProviderRow.secrets_json)).toEqual({ apiKey: 'server-secret' })

    const profileActiveRow = db.prepare(
      'SELECT active_provider FROM stt_profile_settings WHERE profile = ?'
    ).get('default') as { active_provider: string }
    expect(profileActiveRow.active_provider).toBe('openai')

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

  it('deletes a stored STT provider row and falls back to browser when it was active', async () => {
    const ctrl = await initController()
    const user = { id: 7, username: 'bob', role: 'admin' }

    await ctrl.saveSettings(makeCtx(user, {
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: 'server-secret' },
    }, { provider: 'openai' }))

    const deleteCtx = makeCtx(user, {}, { provider: 'openai' })
    await ctrl.deleteProvider(deleteCtx)

    expect(deleteCtx.status).toBe(200)
    expect(deleteCtx.body).toEqual({
      success: true,
      deleted: true,
      activeProvider: 'browser',
    })
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM stt_profile_provider_settings WHERE profile = ? AND provider = ?'
    ).get('default', 'openai').count).toBe(0)

    const activeRow = db.prepare('SELECT active_provider FROM stt_profile_settings WHERE profile = ?').get('default') as { active_provider: string }
    expect(activeRow.active_provider).toBe('browser')
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

  it('only activates the fixed local STT provider after its model is usable', async () => {
    const ctrl = await initController()
    const user = { id: 12, username: 'local-user', role: 'admin' }

    const unavailableCtx = makeCtx(user, { provider: 'local' })
    await ctrl.saveActiveProvider(unavailableCtx)
    expect(unavailableCtx.status).toBe(409)
    expect(unavailableCtx.body).toEqual({ error: 'Local STT model is not installed and usable' })

    localModelState.usable = true
    const availableCtx = makeCtx(user, { provider: 'local' })
    await ctrl.saveActiveProvider(availableCtx)
    expect(availableCtx.body).toEqual({ activeProvider: 'local' })

    const listCtx = makeCtx(user)
    await ctrl.listSettings(listCtx)
    expect(listCtx.body).toMatchObject({
      activeProvider: 'local',
      settings: [{
        provider: 'local',
        settings: { model: 'test-local-stt-model' },
        secrets: {},
      }],
    })
  })

  it('starts and finishes an authenticated local stream only for the active local profile', async () => {
    const ctrl = await initController()
    const user = { id: 12, username: 'local-user', role: 'admin' }
    localModelState.usable = true
    await ctrl.saveActiveProvider(makeCtx(user, { provider: 'local' }))
    localStreamMocks.create.mockResolvedValueOnce({ sessionId: 'stream-1' })
    localStreamMocks.finish.mockResolvedValueOnce({
      sessionId: 'stream-1', text: '完成', model: 'test-local-stt-model', durationMs: 2,
    })

    const startCtx = makeCtx(user)
    await ctrl.startLocalStream(startCtx)
    expect(localStreamMocks.create).toHaveBeenCalledWith('12:default')
    expect(startCtx.body).toEqual({ sessionId: 'stream-1' })

    const finishCtx = makeCtx(user, {}, { sessionId: 'stream-1' })
    await ctrl.finishLocalStream(finishCtx)
    expect(localStreamMocks.finish).toHaveBeenCalledWith('stream-1', '12:default', expect.any(AbortSignal))
    expect(finishCtx.body).toMatchObject({ text: '完成' })
  })
})

describe('stt routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/modules/studio/routes/stt')
    vi.doUnmock('../../packages/server/src/modules/studio/controllers/stt')
  })

  it('registers the protected STT settings and transcribe routes', async () => {
    const listSettings = vi.fn(async (ctx: any) => { ctx.body = { route: 'listSettings' } })
    const saveActiveProvider = vi.fn(async (ctx: any) => { ctx.body = { route: 'saveActiveProvider' } })
    const saveSettings = vi.fn(async (ctx: any) => { ctx.body = { route: 'saveSettings' } })
    const deleteProvider = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteProvider' } })
    const deleteSecret = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteSecret' } })
    const deleteBaseUrlPreset = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteBaseUrlPreset' } })
    const profileStatus = vi.fn(async (ctx: any) => { ctx.body = { route: 'profileStatus' } })
    const missingProfileAudio = vi.fn(async (ctx: any) => { ctx.body = { route: 'missingProfileAudio' } })
    const mcuVoiceTurn = vi.fn(async (ctx: any) => { ctx.body = { route: 'mcuVoiceTurn' } })
    const transcribe = vi.fn(async (ctx: any) => { ctx.body = { route: 'transcribe' } })
    const transcribeVoiceProxy = vi.fn(async (ctx: any) => { ctx.body = { route: 'transcribeVoiceProxy' } })
    const startLocalStream = vi.fn()
    const pushLocalStreamChunk = vi.fn()
    const finishLocalStream = vi.fn()
    const cancelLocalStream = vi.fn()

    vi.doMock('../../packages/server/src/modules/studio/controllers/stt', () => ({
      listSettings,
      saveActiveProvider,
      saveSettings,
      deleteProvider,
      deleteSecret,
      deleteBaseUrlPreset,
      profileStatus,
      missingProfileAudio,
      mcuVoiceTurn,
      transcribe,
      transcribeVoiceProxy,
      startLocalStream,
      pushLocalStreamChunk,
      finishLocalStream,
      cancelLocalStream,
    }))

    const { sttProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/stt')
    const protectedPaths = sttProtectedRoutes.stack.map((entry: any) => entry.path)

    expect(protectedPaths).toEqual(expect.arrayContaining([
      '/api/studio/stt/settings',
      '/api/studio/stt/local-model',
      '/api/studio/stt/local-model/download',
      '/api/studio/voice/proxy/:profile/v1/audio/transcriptions',
      '/api/studio/stt/profile-status',
      '/api/studio/stt/profile-status/missing-audio',
      '/api/studio/mcu/voice-turn',
      '/api/studio/stt/settings/active',
      '/api/studio/stt/settings/:provider',
      '/api/studio/stt/settings/:provider',
      '/api/studio/stt/settings/:provider/base-url-preset',
      '/api/studio/stt/settings/:provider/secret/:secretName',
      '/api/studio/stt/local-stream',
      '/api/studio/stt/local-stream/:sessionId/chunk',
      '/api/studio/stt/local-stream/:sessionId/finish',
      '/api/studio/stt/local-stream/:sessionId',
      '/api/studio/stt/transcribe',
    ]))

    const transcribeLayer: any = sttProtectedRoutes.stack.find((entry: any) => entry.path === '/api/studio/stt/transcribe')
    const ctx: any = { request: { body: {} }, body: null }

    await transcribeLayer.stack[0](ctx, undefined)

    expect(transcribe).toHaveBeenCalledWith(ctx, undefined)
    expect(ctx.body).toEqual({ route: 'transcribe' })
  })
})
