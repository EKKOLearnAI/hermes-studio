// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockSystemApi = vi.hoisted(() => ({
  fetchAvailableModels: vi.fn(),
  updateDefaultModel: vi.fn(),
  addCustomProvider: vi.fn(),
  removeCustomProvider: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => mockSystemApi)

import { useAppStore } from '@/stores/hermes/app'
import { useModelsStore } from '@/stores/hermes/models'

describe('Models Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('keeps the sidebar model picker in sync after provider model visibility changes', async () => {
    const visibleGroups = [
      {
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-test',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        available_models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        model_meta: {
          'deepseek-v4-pro': { preview: true },
        },
      },
    ]
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-v4-flash',
      default_provider: 'deepseek',
      groups: visibleGroups,
      allProviders: visibleGroups,
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
      },
    })

    const appStore = useAppStore()
    appStore.modelGroups = [
      {
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-test',
        models: ['deepseek-v4-flash'],
        available_models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      },
    ]

    const modelsStore = useModelsStore()
    await modelsStore.fetchProviders()

    expect(modelsStore.providers[0].models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(appStore.modelGroups[0].models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(appStore.modelGroups[0].available_models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(appStore.modelGroups[0].model_meta).toEqual({
      'deepseek-v4-pro': { preview: true },
    })
    expect(appStore.modelVisibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
    })
    expect(appStore.selectedModel).toBe('deepseek-v4-flash')
    expect(appStore.selectedProvider).toBe('deepseek')
  })

  describe('auth error handling', () => {
    it('sets isAuthError flag on 401 and skips subsequent calls', async () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockSystemApi.fetchAvailableModels.mockRejectedValue(new Error('Unauthorized'))

      const modelsStore = useModelsStore()

      await expect(modelsStore.fetchProviders()).rejects.toThrow('Unauthorized')
      expect(modelsStore.isAuthError).toBe(true)
      expect(modelsStore.error).toBe('Unauthorized')

      // Subsequent call should be skipped
      await modelsStore.fetchProviders()
      expect(consoleWarn).toHaveBeenCalledWith('[fetchProviders] Skipping due to previous auth error')
      expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalledTimes(1)

      consoleWarn.mockRestore()
      consoleError.mockRestore()
    })

    it('clears isAuthError flag on successful fetch', async () => {
      mockSystemApi.fetchAvailableModels.mockResolvedValueOnce({
        default: 'deepseek-chat',
        default_provider: 'deepseek',
        groups: [{
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          models: ['deepseek-chat'],
          api_key: '',
        }],
        allProviders: [],
      })

      const modelsStore = useModelsStore()
      modelsStore.isAuthError = true
      modelsStore.error = 'Previous error'

      // Clear the error state to allow retry
      modelsStore.isAuthError = false
      modelsStore.error = null

      await modelsStore.fetchProviders()

      expect(modelsStore.isAuthError).toBe(false)
      expect(modelsStore.error).toBe(null)
      expect(modelsStore.providers.length).toBe(1)
    })

    it('does not set isAuthError for non-auth errors', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockSystemApi.fetchAvailableModels.mockRejectedValue(new Error('Network Error'))

      const modelsStore = useModelsStore()

      await expect(modelsStore.fetchProviders()).rejects.toThrow('Network Error')
      expect(modelsStore.isAuthError).toBe(false)
      expect(modelsStore.error).toBe('Network Error')
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch providers:', expect.any(Error))

      consoleError.mockRestore()
    })

    it('allows retry after isAuthError is manually cleared', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockSystemApi.fetchAvailableModels
        .mockRejectedValueOnce(new Error('Unauthorized'))
        .mockResolvedValueOnce({
          default: 'deepseek-chat',
          default_provider: 'deepseek',
          groups: [{
            provider: 'deepseek',
            label: 'DeepSeek',
            base_url: 'https://api.deepseek.com/v1',
            models: ['deepseek-chat'],
            api_key: '',
          }],
          allProviders: [],
        })

      const modelsStore = useModelsStore()

      // First call fails with auth error
      await expect(modelsStore.fetchProviders()).rejects.toThrow('Unauthorized')
      expect(modelsStore.isAuthError).toBe(true)

      // Manually clear auth error (simulating user login)
      modelsStore.isAuthError = false

      // Second call should succeed
      await modelsStore.fetchProviders()
      expect(modelsStore.isAuthError).toBe(false)
      expect(modelsStore.providers.length).toBe(1)

      consoleError.mockRestore()
    })
  })
})
