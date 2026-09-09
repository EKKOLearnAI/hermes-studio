// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchTtsSettings: vi.fn(),
  saveActiveTtsProvider: vi.fn(),
  getActiveProfileName: vi.fn(() => 'default'),
}))
vi.mock('@/api/studio/tts-settings', () => api)
vi.mock('@/api/client', () => ({
  hasApiKey: () => true,
  getStoredUserId: () => 7,
  getActiveProfileName: api.getActiveProfileName,
}))
vi.mock('@/api/studio/stt-settings', () => ({
  fetchSttSettings: async () => ({ activeProvider: 'browser', providers: [] }),
}))
vi.mock('@/composables/useSttSettings', () => ({
  useSttSettings: () => ({ provider: { value: 'browser' }, loadServerSttSettings: async () => {}, setProvider: () => {} }),
}))
vi.mock('@/composables/useLocalSttModel', () => ({ useLocalSttModel: () => ({ refresh: async () => null }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  api.getActiveProfileName.mockReturnValue('default')
  api.saveActiveTtsProvider.mockResolvedValue('doubao')
})

it('uses server Doubao speed on a fresh client', async () => {
  api.fetchTtsSettings.mockResolvedValue({
    activeProvider: 'doubao',
    providers: [{ provider: 'doubao', settings: { speed: '0.5' }, secrets: {} }],
  })
  const { useVoiceSettings, loadServerTtsSettings } = await import('@/composables/useVoiceSettings')
  await loadServerTtsSettings()
  const settings = useVoiceSettings()
  expect(settings.provider.value).toBe('doubao')
  expect(settings.doubaoSpeed.value).toBe('0.5')
})

it('resets stale local speed when activating a profile with no configured speed', async () => {
  api.fetchTtsSettings.mockResolvedValue({
    activeProvider: 'doubao',
    providers: [{ provider: 'doubao', settings: {}, secrets: {} }],
  })
  const { useVoiceSettings } = await import('@/composables/useVoiceSettings')
  const settings = useVoiceSettings()
  settings.setDoubaoSpeed('0.5')
  const { useVoiceApiConnections } = await import('@/composables/useVoiceApiConnections')
  const connections = useVoiceApiConnections()
  await connections.refresh()
  await connections.setActiveConnection('tts', 'tts-doubao')
  expect(settings.doubaoSpeed.value).toBe('1')
})

it('replaces persisted speed with the current profile speed and resets absent settings', async () => {
  localStorage.setItem('hermes-tts-settings-v2', JSON.stringify({ doubaoSpeed: '1.8' }))
  api.fetchTtsSettings
    .mockResolvedValueOnce({
      activeProvider: 'doubao',
      providers: [{ provider: 'doubao', settings: { speed: '0.5' }, secrets: {} }],
    })
    .mockResolvedValueOnce({
      activeProvider: 'doubao',
      providers: [{ provider: 'doubao', settings: {}, secrets: {} }],
    })
    .mockResolvedValueOnce({ activeProvider: 'edge', providers: [] })
  const { useVoiceSettings, loadServerTtsSettings } = await import('@/composables/useVoiceSettings')
  const settings = useVoiceSettings()
  await loadServerTtsSettings()
  expect(settings.doubaoSpeed.value).toBe('0.5')
  api.getActiveProfileName.mockReturnValue('work')
  await loadServerTtsSettings()
  expect(settings.doubaoSpeed.value).toBe('1')
  settings.setDoubaoSpeed('0.7')
  api.getActiveProfileName.mockReturnValue('personal')
  await loadServerTtsSettings()
  expect(settings.doubaoSpeed.value).toBe('1')
})
