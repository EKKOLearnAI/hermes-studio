// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'hermes-tts-settings-v2'

describe('tts settings api', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    localStorage.setItem('hermes_server_url', 'https://hermes.example')
    localStorage.setItem('hermes_api_key', 'jwt-token')
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ settings: [] }),
    }) as any
  })

  it('loads settings from protected backend api', async () => {
    const api = await import('../../packages/client/src/api/hermes/tts-settings')
    await api.fetchTtsSettings()

    expect(fetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/tts/settings',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }),
      }),
    )
  })

  it('saves provider settings with optional secrets', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ setting: { provider: 'mimo', settings: {}, secrets: {}, updatedAt: 1 } }),
    }) as any

    const api = await import('../../packages/client/src/api/hermes/tts-settings')
    await api.saveTtsSettings('mimo', {
      settings: { model: 'mimo-v2.5-tts' },
      secrets: { apiKey: 'mimo-key' },
    })

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({
      settings: { model: 'mimo-v2.5-tts' },
      secrets: { apiKey: 'mimo-key' },
    })
  })
})

describe('useVoiceSettings secret boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('does not persist raw provider api keys or voice clone data to localStorage', async () => {
    const { nextTick } = await import('vue')
    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    settings.setOpenaiApiKey('openai-secret')
    settings.setCustomApiKey('custom-secret')
    settings.setMimoApiKey('mimo-secret')
    settings.setMimoVoiceCloneDataUri('data:audio/wav;base64,SECRETVOICE')
    settings.setProvider('mimo')
    await nextTick()

    const raw = localStorage.getItem(STORAGE_KEY) || ''
    expect(raw).not.toContain('openai-secret')
    expect(raw).not.toContain('custom-secret')
    expect(raw).not.toContain('mimo-secret')
    expect(raw).not.toContain('SECRETVOICE')
    expect(raw).toContain('mimo')
  })

  it('removes legacy raw secrets from existing localStorage settings on import', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      provider: 'mimo',
      openaiApiKey: 'sk-old',
      customApiKey: 'custom-old',
      mimoApiKey: 'mimo-old',
      mimoVoiceCloneDataUri: 'data:audio/wav;base64,OLDVOICE',
      mimoModel: 'mimo-v2.5-tts',
    }))

    await import('../../packages/client/src/composables/useVoiceSettings')

    const raw = localStorage.getItem(STORAGE_KEY) || ''
    expect(raw).not.toContain('sk-old')
    expect(raw).not.toContain('custom-old')
    expect(raw).not.toContain('mimo-old')
    expect(raw).not.toContain('OLDVOICE')
    expect(JSON.parse(raw)).toMatchObject({ provider: 'mimo', mimoModel: 'mimo-v2.5-tts' })
  })

  it('applies masked backend settings without exposing raw secret values', async () => {
    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    settings.applyServerTtsSettings([
      {
        provider: 'mimo',
        settings: { model: 'mimo-v2.5-tts', authMode: 'both' },
        secrets: { apiKey: '••••7890', voiceCloneDataUri: '[stored]', voiceCloneFileName: 'sample.wav' },
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    expect(settings.mimoApiKey.value).toBe('')
    expect(settings.mimoApiKeyPreview.value).toBe('••••7890')
    expect(settings.mimoHasApiKey.value).toBe(true)
    expect(settings.mimoHasVoiceCloneData.value).toBe(true)
    expect(settings.mimoVoiceCloneFileName.value).toBe('sample.wav')
  })
})
