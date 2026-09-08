// @vitest-environment jsdom
import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { hasApiKeyMock, loadServerTtsSettingsMock } = vi.hoisted(() => ({
  hasApiKeyMock: vi.fn(),
  loadServerTtsSettingsMock: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  hasApiKey: hasApiKeyMock,
}))

vi.mock('@/composables/useVoiceSettings', () => ({
  loadServerTtsSettings: loadServerTtsSettingsMock,
}))

import { watchServerTtsSettingsHydration } from '@/composables/useTtsSettingsHydration'

describe('TTS settings hydration lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasApiKeyMock.mockReturnValue(false)
    loadServerTtsSettingsMock.mockResolvedValue(undefined)
  })

  it('hydrates after login once the active profile is known', async () => {
    const isLoginPage = ref(true)
    const activeProfileName = ref<string | null>(null)
    const stop = watchServerTtsSettingsHydration({
      isLoginPage: () => isLoginPage.value,
      activeProfileName: () => activeProfileName.value,
    })

    hasApiKeyMock.mockReturnValue(true)
    isLoginPage.value = false
    await nextTick()
    expect(loadServerTtsSettingsMock).not.toHaveBeenCalled()

    activeProfileName.value = 'default'
    await nextTick()
    expect(loadServerTtsSettingsMock).toHaveBeenCalledOnce()

    stop()
  })

  it('rehydrates when the active profile changes', async () => {
    hasApiKeyMock.mockReturnValue(true)
    const isLoginPage = ref(false)
    const activeProfileName = ref<string | null>('default')
    const stop = watchServerTtsSettingsHydration({
      isLoginPage: () => isLoginPage.value,
      activeProfileName: () => activeProfileName.value,
    })

    expect(loadServerTtsSettingsMock).toHaveBeenCalledOnce()

    activeProfileName.value = 'work'
    await nextTick()
    expect(loadServerTtsSettingsMock).toHaveBeenCalledTimes(2)

    stop()
  })
})
