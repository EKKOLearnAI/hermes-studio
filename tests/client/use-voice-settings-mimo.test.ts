// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const { fetchTtsSettingsMock } = vi.hoisted(() => ({
  fetchTtsSettingsMock: vi.fn(),
}))

vi.mock('@/api/studio/tts-settings', () => ({
  fetchTtsSettings: fetchTtsSettingsMock,
}))

const STORAGE_KEY = 'hermes-tts-settings-v2'

describe('useVoiceSettings MiMo settings', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    fetchTtsSettingsMock.mockReset()
  })

  it('defaults MiMo auth and voice clone settings', async () => {
    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    expect(settings.mimoAuthMode.value).toBe('bearer')
    expect(settings.mimoVoiceCloneDataUri.value).toBe('')
    expect(settings.mimoVoiceCloneFileName.value).toBe('')
    expect(settings.mimoVoiceCloneFormat.value).toBe('wav')
  })

  it('hydrates the active TTS provider from the server for a fresh browser profile', async () => {
    fetchTtsSettingsMock.mockResolvedValue({ providers: [], activeProvider: 'openai' })

    const { loadServerTtsSettings, useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    expect(settings.provider.value).toBe('webspeech')

    await loadServerTtsSettings()
    await nextTick()

    expect(settings.provider.value).toBe('openai')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')).toMatchObject({
      provider: 'openai',
    })
  })

  it('persists MiMo auth mode and voice clone fields', async () => {
    const { useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    settings.setMimoAuthMode('api-key')
    settings.setMimoModel('mimo-v2.5-tts-voiceclone')
    settings.setMimoVoiceCloneDataUri('data:audio/mp3;base64,ZmFrZQ==')
    settings.setMimoVoiceCloneFileName('sample.mp3')
    settings.setMimoVoiceCloneFormat('mp3')
    await nextTick()

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')).toMatchObject({
      mimoAuthMode: 'api-key',
      mimoModel: 'mimo-v2.5-tts-voiceclone',
      mimoVoiceCloneDataUri: 'data:audio/mp3;base64,ZmFrZQ==',
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
})
