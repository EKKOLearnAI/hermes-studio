// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockSystemApi = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
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
    window.localStorage.clear()
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

    await store.switchModel('test', 'deepseek')
    expect(store.selectedModel).toBe('test')
    expect(store.customModels).toEqual({ deepseek: ['test'] })

    await store.removeCustomModel('test', 'deepseek')
    expect(store.customModels).toEqual({})
    expect(store.selectedModel).toBe('deepseek-v4-flash')
    expect(mockSystemApi.updateDefaultModel).toHaveBeenLastCalledWith({
      default: 'deepseek-v4-flash',
      provider: 'deepseek',
    })
  })
})
