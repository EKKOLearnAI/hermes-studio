// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockSystemApi = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  updateDefaultModel: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => mockSystemApi)

import { useAppStore } from '@/stores/hermes/app'

describe('App Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists desktop sidebar collapsed state to localStorage', () => {
    const store = useAppStore()

    expect(store.sidebarCollapsed).toBe(false)

    store.toggleSidebarCollapsed()
    expect(store.sidebarCollapsed).toBe(true)
    expect(window.localStorage.getItem('hermes_sidebar_collapsed')).toBe('1')

    store.toggleSidebarCollapsed()
    expect(store.sidebarCollapsed).toBe(false)
    expect(window.localStorage.getItem('hermes_sidebar_collapsed')).toBe('0')
  })

  it('does not expose a browser-triggered self-update action', () => {
    const store = useAppStore()

    expect('doUpdate' in store).toBe(false)
  })

  it('does not refetch available models within the cache window after an empty response', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: '',
      default_provider: '',
      groups: [],
      allProviders: [],
    })
    const store = useAppStore()

    await store.loadModels()
    await store.loadModels()

    expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalledTimes(1)
  })

  it('can force-refresh available models after provider changes', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: '',
      default_provider: '',
      groups: [],
      allProviders: [],
    })
    const store = useAppStore()

    await store.loadModels()
    await store.reloadModels()

    expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalledTimes(2)
  })

  it('waits only up to the run timeout for the first available models request', async () => {
    vi.useFakeTimers()
    mockSystemApi.fetchAvailableModels.mockReturnValue(new Promise(() => {}))
    const store = useAppStore()
    let resolved = false

    const waitPromise = store.waitForModelsForRun(15000).then(() => {
      resolved = true
    })

    expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(14999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waitPromise
    expect(resolved).toBe(true)
    expect(store.modelGroups).toEqual([])
  })
})
