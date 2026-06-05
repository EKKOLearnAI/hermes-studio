import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('tts settings controller', () => {
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
    return await import('../../packages/server/src/controllers/hermes/tts')
  }

  function makeCtx(user: any | null, body: any = {}, params: Record<string, string> = {}) {
    return {
      state: user ? { user } : {},
      request: { body },
      params,
      status: 200,
      body: null,
      set: vi.fn(),
    } as any
  }

  it('rejects unauthenticated settings requests with 401', async () => {
    const ctrl = await initController()

    const listCtx = makeCtx(null)
    await ctrl.listSettings(listCtx)
    expect(listCtx.status).toBe(401)
    expect(listCtx.body).toEqual({ error: 'Unauthorized' })

    const saveCtx = makeCtx(null, {}, { provider: 'openai' })
    await ctrl.saveSettings(saveCtx)
    expect(saveCtx.status).toBe(401)
    expect(saveCtx.body).toEqual({ error: 'Unauthorized' })

    const deleteCtx = makeCtx(null, {}, { provider: 'openai', secretName: 'apiKey' })
    await ctrl.deleteSecret(deleteCtx)
    expect(deleteCtx.status).toBe(401)
    expect(deleteCtx.body).toEqual({ error: 'Unauthorized' })
  })

  it('saves masked settings rows and lists them for the authenticated user', async () => {
    const ctrl = await initController()
    const user = { id: 9, username: 'alice', role: 'admin' }

    const saveCtx = makeCtx(user, {
      settings: {
        baseUrl: 'https://api.example.com/v1',
        model: 'tts-1',
      },
      secrets: {
        apiKey: 'sk-live-1234',
      },
    }, { provider: 'openai' })

    await ctrl.saveSettings(saveCtx)

    expect(saveCtx.status).toBe(200)
    expect(saveCtx.body.setting).toMatchObject({
      provider: 'openai',
      settings: {
        baseUrl: 'https://api.example.com/v1',
        model: 'tts-1',
      },
      secrets: {
        apiKey: '••••1234',
      },
    })
    expect(JSON.stringify(saveCtx.body)).not.toContain('sk-live-1234')

    const listCtx = makeCtx(user)
    await ctrl.listSettings(listCtx)

    expect(listCtx.status).toBe(200)
    expect(listCtx.body).toEqual({
      settings: [saveCtx.body.setting],
    })
  })

  it('rejects unknown providers and secrets with 400', async () => {
    const ctrl = await initController()
    const user = { id: 4, username: 'bob', role: 'admin' }

    const badProviderCtx = makeCtx(user, {}, { provider: 'nope' })
    await ctrl.saveSettings(badProviderCtx)
    expect(badProviderCtx.status).toBe(400)
    expect(badProviderCtx.body).toEqual({ error: 'unknown TTS provider' })

    const badSecretCtx = makeCtx(user, {}, { provider: 'openai', secretName: 'token' })
    await ctrl.deleteSecret(badSecretCtx)
    expect(badSecretCtx.status).toBe(400)
    expect(badSecretCtx.body).toEqual({ error: 'unknown TTS provider secret' })
  })

  it('rejects unsafe base urls when saving settings', async () => {
    const ctrl = await initController()
    const ctx = makeCtx(
      { id: 5, username: 'eve', role: 'admin' },
      {
        settings: {
          baseUrl: 'http://localhost:8000/v1',
        },
      },
      { provider: 'openai' },
    )

    await ctrl.saveSettings(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.error).toMatch(/OpenAI TTS baseUrl/)
  })
})
