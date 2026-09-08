// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const {
  fetchTtsSettingsMock,
  getActiveProfileNameMock,
  getStoredUserIdMock,
  hasApiKeyMock,
} = vi.hoisted(() => ({
  fetchTtsSettingsMock: vi.fn(),
  getActiveProfileNameMock: vi.fn(),
  getStoredUserIdMock: vi.fn(),
  hasApiKeyMock: vi.fn(),
}))

vi.mock('@/api/studio/tts-settings', () => ({
  fetchTtsSettings: fetchTtsSettingsMock,
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: getActiveProfileNameMock,
  getStoredUserId: getStoredUserIdMock,
  hasApiKey: hasApiKeyMock,
}))

const STORAGE_KEY = 'hermes-tts-settings-v2'

describe('useVoiceSettings MiMo settings', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    fetchTtsSettingsMock.mockReset()
    getActiveProfileNameMock.mockReset().mockReturnValue('default')
    getStoredUserIdMock.mockReset().mockReturnValue(7)
    hasApiKeyMock.mockReset().mockReturnValue(true)
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

  it('waits for authentication before loading server TTS settings', async () => {
    hasApiKeyMock.mockReturnValue(false)

    const { loadServerTtsSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    await loadServerTtsSettings()

    expect(fetchTtsSettingsMock).not.toHaveBeenCalled()
  })

  it('loads once per user and profile context', async () => {
    fetchTtsSettingsMock
      .mockResolvedValueOnce({ providers: [], activeProvider: 'openai' })
      .mockResolvedValueOnce({ providers: [], activeProvider: 'custom' })

    const { loadServerTtsSettings, useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()

    await loadServerTtsSettings()
    await loadServerTtsSettings()
    expect(fetchTtsSettingsMock).toHaveBeenCalledTimes(1)
    expect(settings.provider.value).toBe('openai')

    getActiveProfileNameMock.mockReturnValue('work')
    await loadServerTtsSettings()
    await loadServerTtsSettings()

    expect(fetchTtsSettingsMock).toHaveBeenCalledTimes(2)
    expect(settings.provider.value).toBe('custom')
  })

  it('ignores a stale response after the active profile changes', async () => {
    let resolveDefault!: (value: { providers: never[]; activeProvider: 'openai' }) => void
    let resolveWork!: (value: { providers: never[]; activeProvider: 'custom' }) => void
    fetchTtsSettingsMock
      .mockImplementationOnce(() => new Promise(resolve => { resolveDefault = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveWork = resolve }))

    const { loadServerTtsSettings, useVoiceSettings } = await import('../../packages/client/src/composables/useVoiceSettings')
    const settings = useVoiceSettings()
    const defaultRequest = loadServerTtsSettings()

    getActiveProfileNameMock.mockReturnValue('work')
    const workRequest = loadServerTtsSettings()

    resolveDefault({ providers: [], activeProvider: 'openai' })
    await defaultRequest
    expect(settings.provider.value).toBe('webspeech')

    resolveWork({ providers: [], activeProvider: 'custom' })
    await workRequest
    expect(settings.provider.value).toBe('custom')
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
