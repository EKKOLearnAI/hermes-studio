// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const configMock = vi.hoisted(() => ({ fetchConfig: vi.fn() }))
vi.mock('@/api/hermes/config', () => ({
  fetchConfig: configMock.fetchConfig,
  updateConfigSection: vi.fn(),
}))

import { useSettingsStore } from '@/stores/hermes/settings'

describe('settings store load result', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('returns true only after settings are loaded', async () => {
    configMock.fetchConfig.mockResolvedValue({ display: { approval_bell: true } })
    const store = useSettingsStore()
    await expect(store.fetchSettings()).resolves.toBe(true)
    expect(store.display.approval_bell).toBe(true)
  })

  it('does not commit a stale load when its generation is no longer active', async () => {
    configMock.fetchConfig.mockResolvedValue({ display: { approval_bell: true } })
    const store = useSettingsStore()
    store.display = { approval_bell: false }

    await expect(store.fetchSettings({ shouldCommit: () => false })).resolves.toBe(false)
    expect(store.display.approval_bell).toBe(false)
  })

  it('returns false and keeps the previous display state when loading fails', async () => {
    const store = useSettingsStore()
    store.display = { approval_bell: true }
    configMock.fetchConfig.mockRejectedValue(new Error('unavailable'))
    await expect(store.fetchSettings()).resolves.toBe(false)
    expect(store.display.approval_bell).toBe(true)
  })
})
