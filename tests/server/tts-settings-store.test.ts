import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('tts settings store', () => {
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

  async function initStore() {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    return {
      schemas,
      store: await import('../../packages/server/src/db/hermes/tts-settings-store'),
    }
  }

  it('masks public secret readback and preserves existing secrets on upsert', async () => {
    const { store } = await initStore()

    const first = store.upsertTtsProviderSettings(7, 'openai', {
      settings: {
        baseUrl: 'https://api.example.com/v1',
        model: 'tts-1',
      },
      secrets: {
        apiKey: 'sk-test-1234',
      },
    })

    expect(first.secrets.apiKey).toBe('••••1234')
    expect(first.secrets.apiKey).not.toContain('sk-test-1234')

    const updated = store.upsertTtsProviderSettings(7, 'openai', {
      settings: {
        voice: 'nova',
      },
      secrets: {},
      preserveExistingSecrets: true,
    })

    expect(updated.settings).toEqual({
      baseUrl: 'https://api.example.com/v1',
      model: 'tts-1',
      voice: 'nova',
    })
    expect(updated.secrets).toEqual({ apiKey: '••••1234' })

    expect(store.listTtsProviderSettings(7)).toEqual([updated])
    expect(store.getTtsProviderPublicSettings(7, 'openai')).toEqual(updated)
    expect(store.getTtsProviderConfigForSynthesis(7, 'openai')).toEqual({
      provider: 'openai',
      settings: {
        baseUrl: 'https://api.example.com/v1',
        model: 'tts-1',
        voice: 'nova',
      },
      secrets: {
        apiKey: 'sk-test-1234',
      },
    })
  })

  it('clears a single secret without removing the provider row', async () => {
    const { store } = await initStore()

    store.upsertTtsProviderSettings(11, 'mimo', {
      settings: {
        baseUrl: 'https://mimo.example.com/v1',
        model: 'mimo-v2.5-tts-voiceclone',
      },
      secrets: {
        apiKey: 'mimo-secret',
        voiceCloneDataUri: 'data:audio/wav;base64,ZmFrZQ==',
        voiceCloneFileName: 'sample.wav',
      },
    })

    const cleared = store.clearTtsProviderSecret(11, 'mimo', 'voiceCloneDataUri')
    expect(cleared?.provider).toBe('mimo')
    expect(cleared?.settings).toEqual({
      baseUrl: 'https://mimo.example.com/v1',
      model: 'mimo-v2.5-tts-voiceclone',
    })
    expect(cleared?.secrets).toEqual({
      apiKey: '••••cret',
      voiceCloneFileName: '[stored]',
    })

    expect(store.getTtsProviderConfigForSynthesis(11, 'mimo')).toEqual({
      provider: 'mimo',
      settings: {
        baseUrl: 'https://mimo.example.com/v1',
        model: 'mimo-v2.5-tts-voiceclone',
      },
      secrets: {
        apiKey: 'mimo-secret',
        voiceCloneFileName: 'sample.wav',
      },
    })
  })

  it('rejects unsafe stored base urls', async () => {
    const { store } = await initStore()

    expect(() => {
      store.upsertTtsProviderSettings(3, 'openai', {
        settings: {
          baseUrl: 'http://127.0.0.1:8000/v1',
        },
      })
    }).toThrow(/OpenAI TTS baseUrl/)
  })

  it('rejects oversized MiMo clone payloads and path separators in clone file names', async () => {
    const { store } = await initStore()
    const tooLargeBase64 = 'A'.repeat(Math.ceil(((10 * 1024 * 1024) + 1) / 3) * 4)

    expect(() => {
      store.upsertTtsProviderSettings(5, 'mimo', {
        settings: {
          baseUrl: 'https://mimo.example.com/v1',
          model: 'mimo-v2.5-tts-voiceclone',
        },
        secrets: {
          apiKey: 'secret',
          voiceCloneDataUri: `data:audio/wav;base64,${tooLargeBase64}`,
        },
      })
    }).toThrow('MiMo TTS voiceCloneDataUri must be 10 MiB or smaller')

    expect(() => {
      store.upsertTtsProviderSettings(5, 'mimo', {
        settings: {
          baseUrl: 'https://mimo.example.com/v1',
          model: 'mimo-v2.5-tts-voiceclone',
        },
        secrets: {
          apiKey: 'secret',
          voiceCloneDataUri: 'data:audio/wav;base64,ZmFrZQ==',
          voiceCloneFileName: '../secret.wav',
        },
      })
    }).toThrow('MiMo TTS voiceCloneFileName must not contain path separators')
  })
})
