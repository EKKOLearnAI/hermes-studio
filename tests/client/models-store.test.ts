// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockSystemApi = vi.hoisted(() => ({
  fetchAvailableModels: vi.fn(),
  fetchAvailableModelsForProfile: vi.fn(),
  updateDefaultModel: vi.fn(),
  addCustomProvider: vi.fn(),
  removeCustomProvider: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => mockSystemApi)
vi.mock('@/api/client', () => ({ hasApiKey: () => true }))

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
    const availableModelsResponse = {
      default: 'deepseek-v4-flash',
      default_provider: 'deepseek',
      groups: visibleGroups,
      allProviders: visibleGroups,
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
      },
      profiles: [
        {
          profile: 'default',
          default: 'deepseek-v4-flash',
          default_provider: 'deepseek',
          groups: visibleGroups,
        },
      ],
    }
    mockSystemApi.fetchAvailableModelsForProfile.mockResolvedValue(availableModelsResponse)
    mockSystemApi.fetchAvailableModels.mockResolvedValue(availableModelsResponse)
    mockSystemApi.addCustomProvider.mockResolvedValue(undefined)

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
    await modelsStore.addProvider({
      name: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-test',
      model: 'deepseek-v4-flash',
    })

    expect(mockSystemApi.fetchAvailableModelsForProfile).toHaveBeenCalledWith('default')
    expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalled()
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
})
