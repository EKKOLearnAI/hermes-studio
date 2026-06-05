// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const STORAGE_KEY = 'hermes-tts-settings-v2'

describe('useVoiceSettings MiMo settings', () => {
  beforeEach(() => {
    vi.resetModules()
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
})
