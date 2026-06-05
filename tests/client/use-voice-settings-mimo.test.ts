// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const STORAGE_KEY = 'hermes-tts-settings-v2'

describe('useVoiceSettings MiMo settings', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../packages/client/src/api/hermes/tts-settings')
    localStorage.clear()
  })

  it('defaults MiMo auth and voice clone settings', async () => {
    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    expect(settings.mimoAuthMode.value).toBe('bearer')
    expect(settings.mimoVoiceCloneDataUri.value).toBe('')
    expect(settings.mimoVoiceCloneFileName.value).toBe('')
    expect(settings.mimoVoiceCloneFormat.value).toBe('wav')
  })

  it('persists MiMo auth mode and voice clone metadata without clone audio data', async () => {
    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    settings.setMimoAuthMode('api-key')
    settings.setMimoModel('mimo-v2.5-tts-voiceclone')
    settings.setMimoVoiceCloneDataUri('data:audio/mp3;base64,ZmFrZQ==')
    settings.setMimoVoiceCloneFileName('sample.mp3')
    settings.setMimoVoiceCloneFormat('mp3')
    await nextTick()

    const raw = localStorage.getItem(STORAGE_KEY) || '{}'
    expect(raw).not.toContain('data:audio/mp3')
    expect(JSON.parse(raw)).toMatchObject({
      mimoAuthMode: 'api-key',
      mimoModel: 'mimo-v2.5-tts-voiceclone',
      mimoVoiceCloneFileName: 'sample.mp3',
      mimoVoiceCloneFormat: 'mp3',
    })
  })

  it('sanitizes invalid persisted MiMo auth mode and clone format', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mimoAuthMode: 'bad-mode',
      mimoVoiceCloneFormat: 'ogg',
    }))

    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    expect(settings.mimoAuthMode.value).toBe('bearer')
    expect(settings.mimoVoiceCloneFormat.value).toBe('wav')
  })

  it('clears in-memory secrets when auth state is cleared', async () => {
    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    settings.setProvider('mimo')
    settings.setOpenaiApiKey('pending-openai')
    settings.setCustomApiKey('pending-custom')
    settings.setMimoApiKey('pending-mimo')
    settings.setMimoVoiceCloneDataUri('data:audio/wav;base64,ZmFrZQ==')
    settings.applyServerTtsSettings([
      {
        provider: 'mimo',
        settings: { baseUrl: 'https://mimo.example/v1' },
        secrets: { apiKey: '••••mimo', voiceCloneDataUri: '[stored]', voiceCloneFileName: 'sample.wav' },
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    ])

    window.dispatchEvent(new Event('hermes-auth-cleared'))

    expect(settings.provider.value).toBe('webspeech')
    expect(settings.openaiApiKey.value).toBe('')
    expect(settings.customApiKey.value).toBe('')
    expect(settings.mimoApiKey.value).toBe('')
    expect(settings.mimoApiKeyPreview.value).toBe('')
    expect(settings.mimoHasApiKey.value).toBe(false)
    expect(settings.mimoHasVoiceCloneData.value).toBe(false)
    expect(settings.mimoVoiceCloneDataUri.value).toBe('')
    expect(settings.mimoBaseUrl.value).toBe('https://api.xiaomimimo.com/v1')
  })

  it('ignores stale server settings responses after auth state is cleared', async () => {
    let resolveSettings!: (value: Array<{
      provider: 'openai'
      settings: Record<string, unknown>
      secrets: Record<string, string>
      updatedAt: string
    }>) => void
    const pendingSettings = new Promise<Array<{
      provider: 'openai'
      settings: Record<string, unknown>
      secrets: Record<string, string>
      updatedAt: string
    }>>(resolve => {
      resolveSettings = resolve
    })
    vi.doMock('../../packages/client/src/api/hermes/tts-settings', () => ({
      fetchTtsSettings: vi.fn(() => pendingSettings),
    }))

    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()
    const load = settings.loadServerTtsSettings(true)

    window.dispatchEvent(new Event('hermes-auth-cleared'))
    resolveSettings([
      {
        provider: 'openai',
        settings: { baseUrl: 'https://stale.example/v1', model: 'tts-1', voice: 'alloy' },
        secrets: { apiKey: '••••xxxx' },
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    ])
    await load

    expect(settings.openaiHasApiKey.value).toBe(false)
    expect(settings.openaiApiKeyPreview.value).toBe('')
    expect(settings.openaiBaseUrl.value).toBe('')

    vi.doUnmock('../../packages/client/src/api/hermes/tts-settings')
  })
})
