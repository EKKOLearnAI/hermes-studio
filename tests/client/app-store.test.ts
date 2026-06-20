// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockSystemApi = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelAlias: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => mockSystemApi)
vi.mock('@/api/client', () => ({ hasApiKey: () => true }))

import { useAppStore } from '@/stores/hermes/app'

describe('App Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockSystemApi.addCustomModel.mockResolvedValue({ success: true, custom_models: {} })
    mockSystemApi.removeCustomModel.mockResolvedValue({ success: true, custom_models: {} })
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

  it('loads model visibility and falls back when the configured default is hidden', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-reasoner'],
        },
      ],
      allProviders: [],
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.modelVisibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
    })
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
    expect(store.customModels).toEqual({})
    expect(store.isModelVisible('deepseek', 'deepseek-reasoner')).toBe(true)
    expect(store.isModelVisible('deepseek', 'deepseek-chat')).toBe(false)
  })

  it('loads aliases while falling back from a hidden default without rehydrating it as custom', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-reasoner'],
          available_models: ['deepseek-chat', 'deepseek-reasoner'],
        },
      ],
      allProviders: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-chat', 'deepseek-reasoner'],
        },
      ],
      model_aliases: {
        deepseek: { 'deepseek-reasoner': 'Reasoner Alias' },
      },
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.modelAliases).toEqual({
      deepseek: { 'deepseek-reasoner': 'Reasoner Alias' },
    })
    expect(store.modelVisibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
    })
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
    expect(store.displayModelName('deepseek-reasoner', 'deepseek')).toBe('Reasoner Alias')
    expect(store.customModels).toEqual({})
  })

  it('persists model visibility without changing the canonical selected model id', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-reasoner',
      default_provider: 'deepseek',
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-reasoner'],
        },
      ],
      allProviders: [],
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    mockSystemApi.updateModelVisibility.mockResolvedValue({
      success: true,
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    const store = useAppStore()

    await store.setModelVisibility('deepseek', { mode: 'include', models: ['deepseek-reasoner'] })

    expect(mockSystemApi.updateModelVisibility).toHaveBeenCalledWith({
      provider: 'deepseek',
      mode: 'include',
      models: ['deepseek-reasoner'],
    })
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
    expect(mockSystemApi.updateDefaultModel).not.toHaveBeenCalled()
  })

  it('marks the client stale when the served Web UI version changes', async () => {
    mockSystemApi.checkHealth.mockResolvedValue({
      status: 'ok',
      webui_version: '0.5.17',
      webui_latest: '0.5.17',
      webui_update_available: false,
    })
    const store = useAppStore()

    await store.checkConnection()

    expect(store.connected).toBe(true)
    expect(store.serverVersion).toBe('0.5.17')
    expect(store.clientOutdated).toBe(true)
    expect(store.updateAvailable).toBe(false)
  })

  it('does not mark the client stale when the served Web UI version matches this bundle', async () => {
    mockSystemApi.checkHealth.mockResolvedValue({
      status: 'ok',
      webui_version: 'test',
      webui_latest: 'test',
      webui_update_available: false,
    })
    const store = useAppStore()

    await store.checkConnection()

    expect(store.serverVersion).toBe('test')
    expect(store.clientOutdated).toBe(false)
  })

  it('clears the updating state and reports failure when self-update request fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSystemApi.triggerUpdate.mockRejectedValue(new Error('install failed'))
    const store = useAppStore()

    const ok = await store.doUpdate()

    expect(ok).toBe(false)
    expect(store.updating).toBe(false)
    expect(consoleError).toHaveBeenCalledWith('Failed to update Hermes Web UI:', expect.any(Error))
    consoleError.mockRestore()
  })

  it('loads model aliases and resolves display names without changing canonical IDs', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-v4-flash',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        models: ['deepseek-v4-flash'],
        api_key: '',
      }],
      allProviders: [],
      model_aliases: {
        deepseek: { 'deepseek-v4-flash': 'Flash Alias' },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('deepseek-v4-flash')
    expect(store.getModelAlias('deepseek-v4-flash', 'deepseek')).toBe('Flash Alias')
    expect(store.displayModelName('deepseek-v4-flash', 'deepseek')).toBe('Flash Alias')
    expect(store.displayModelName('unknown', 'deepseek')).toBe('unknown')
  })

  it('selects the browser active profile default instead of the aggregate response default', async () => {
    window.localStorage.setItem('hermes_active_profile_name', 'tester')
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'glm-5-turbo',
      default_provider: 'custom:glm-coding-plan',
      groups: [{
        provider: 'custom:glm-coding-plan',
        label: 'glm-coding-plan',
        base_url: 'https://api.z.ai/api/anthropic',
        models: ['glm-5-turbo', 'glm-5.1'],
        api_key: '',
      }],
      allProviders: [],
      profiles: [
        {
          profile: 'default',
          default: 'glm-5-turbo',
          default_provider: 'custom:glm-coding-plan',
          groups: [{
            provider: 'custom:glm-coding-plan',
            label: 'glm-coding-plan',
            base_url: 'https://api.z.ai/api/anthropic',
            models: ['glm-5-turbo', 'glm-5.1'],
            api_key: '',
          }],
        },
        {
          profile: 'tester',
          default: 'claude-opus-4-6',
          default_provider: 'custom:subrouter',
          groups: [{
            provider: 'custom:subrouter',
            label: 'subrouter',
            base_url: 'https://subrouter.ai/v1',
            models: ['claude-opus-4-6', 'gpt-5.5'],
            api_key: '',
          }],
        },
      ],
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('claude-opus-4-6')
    expect(store.selectedProvider).toBe('custom:subrouter')
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

  it('keeps the manually selected model on refresh with preserveSelection when it still exists', async () => {
    const deepseekGroup = {
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: '',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    }
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [deepseekGroup],
      allProviders: [],
    })
    mockSystemApi.updateDefaultModel.mockResolvedValue(undefined)
    const store = useAppStore()

    await store.loadModels()
    expect(store.selectedModel).toBe('deepseek-chat')

    // User manually switches away from the config default
    await store.switchModel('deepseek-reasoner', 'deepseek')
    expect(store.selectedModel).toBe('deepseek-reasoner')

    // config.yaml now points at a different default and grows a new model
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [{ ...deepseekGroup, models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4'] }],
      allProviders: [],
    })

    await store.reloadModels({ preserveSelection: true })

    expect(store.modelGroups[0].models).toContain('deepseek-v4')
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
  })

  it('falls back to the config default on refresh when the selected model disappeared', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-reasoner',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: '',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      }],
      allProviders: [],
    })
    mockSystemApi.updateDefaultModel.mockResolvedValue(undefined)
    const store = useAppStore()

    await store.loadModels()
    await store.switchModel('deepseek-chat', 'deepseek')
    expect(store.selectedModel).toBe('deepseek-chat')

    // deepseek-chat got removed from config.yaml
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-reasoner',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: '',
        models: ['deepseek-reasoner'],
      }],
      allProviders: [],
    })

    await store.reloadModels({ preserveSelection: true })

    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
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

  it('keeps aliases scoped to their provider when model IDs overlap', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'shared-model',
      default_provider: 'provider-a',
      groups: [
        {
          provider: 'provider-a',
          label: 'Provider A',
          base_url: 'https://a.example/v1',
          models: ['shared-model'],
          api_key: '',
        },
        {
          provider: 'provider-b',
          label: 'Provider B',
          base_url: 'https://b.example/v1',
          models: ['shared-model'],
          api_key: '',
        },
      ],
      allProviders: [],
      model_aliases: {
        'provider-a': { 'shared-model': 'A Alias' },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.displayModelName('shared-model', 'provider-a')).toBe('A Alias')
    expect(store.displayModelName('shared-model', 'provider-b')).toBe('shared-model')
    expect(store.displayModelName('shared-model')).toBe('A Alias')
  })

  it('rehydrates an active unlisted default model as removable after loading models', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'manually-supported-id',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        models: ['deepseek-v4-flash'],
        api_key: '',
      }],
      allProviders: [],
      model_aliases: {},
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('manually-supported-id')
    expect(store.customModels).toEqual({ deepseek: ['manually-supported-id'] })
  })

  it('loads persisted custom models from the server response', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'gemma-4-26b-a4b-it',
      default_provider: 'google-ai-studio',
      groups: [{
        provider: 'google-ai-studio',
        label: 'Google AI Studio',
        base_url: 'https://generativelanguage.googleapis.com/v1beta',
        models: ['gemma-4-26b-a4b-it'],
        api_key: '',
      }],
      allProviders: [],
      custom_models: {
        'google-ai-studio': ['gemma-4-26b-a4b-it'],
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('gemma-4-26b-a4b-it')
    expect(store.customModels).toEqual({
      'google-ai-studio': ['gemma-4-26b-a4b-it'],
    })
  })

  it('saves and clears model aliases via the Web UI-only alias API', async () => {
    mockSystemApi.updateModelAlias.mockResolvedValue(undefined)
    const store = useAppStore()

    await store.setModelAlias('deepseek-v4-flash', 'deepseek', '  Flash Alias  ')

    expect(mockSystemApi.updateModelAlias).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      alias: 'Flash Alias',
    })
    expect(store.modelAliases).toEqual({ deepseek: { 'deepseek-v4-flash': 'Flash Alias' } })

    await store.setModelAlias('deepseek-v4-flash', 'deepseek', '')
    expect(store.modelAliases).toEqual({})
  })

  it('removes an unlisted custom model and falls back to a listed model when active', async () => {
    mockSystemApi.updateDefaultModel.mockResolvedValue(undefined)
    const store = useAppStore()
    store.modelGroups = [{
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-v4-flash'],
      api_key: '',
    }]
    mockSystemApi.addCustomModel.mockResolvedValue({
      success: true,
      custom_models: { deepseek: ['test'] },
    })
    mockSystemApi.removeCustomModel.mockResolvedValue({
      success: true,
      custom_models: {},
    })

    await store.switchModel('test', 'deepseek')
    expect(store.selectedModel).toBe('test')
    expect(store.customModels).toEqual({ deepseek: ['test'] })
    expect(mockSystemApi.addCustomModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'test',
    })

    await store.removeCustomModel('test', 'deepseek')
    expect(store.customModels).toEqual({})
    expect(mockSystemApi.removeCustomModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'test',
    })
    expect(store.selectedModel).toBe('deepseek-v4-flash')
    expect(mockSystemApi.updateDefaultModel).toHaveBeenLastCalledWith({
      default: 'deepseek-v4-flash',
      provider: 'deepseek',
    })
  })

  it('removes deleted custom models from loaded model groups immediately', async () => {
    mockSystemApi.removeCustomModel.mockResolvedValue({
      success: true,
      custom_models: {},
    })
    const store = useAppStore()
    store.customModels = { deepseek: ['manual-model'] }
    store.modelGroups = [{
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-v4-flash', 'manual-model'],
      available_models: ['deepseek-v4-flash', 'manual-model'],
      api_key: '',
    }]
    store.profileModelGroups = [{
      profile: 'default',
      default: 'deepseek-v4-flash',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        models: ['deepseek-v4-flash', 'manual-model'],
        available_models: ['deepseek-v4-flash', 'manual-model'],
        api_key: '',
      }],
    }]

    await store.removeCustomModel('manual-model', 'deepseek')

    expect(store.modelGroups[0].models).toEqual(['deepseek-v4-flash'])
    expect(store.modelGroups[0].available_models).toEqual(['deepseek-v4-flash'])
    expect(store.profileModelGroups[0].groups[0].models).toEqual(['deepseek-v4-flash'])
    expect(store.profileModelGroups[0].groups[0].available_models).toEqual(['deepseek-v4-flash'])
  })
})
