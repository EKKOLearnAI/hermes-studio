// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProviderCard from '@/components/hermes/models/ProviderCard.vue'
import type { AvailableModelGroup } from '@/api/hermes/system'

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

const dialogMock = vi.hoisted(() => ({
  warning: vi.fn(),
}))

const modelsStoreMock = vi.hoisted(() => ({
  allProviders: [] as AvailableModelGroup[],
  defaultProvider: '',
  defaultModel: '',
  fetchProviders: vi.fn(),
  setDefaultModel: vi.fn(),
  setDefaultProvider: vi.fn(),
  removeProvider: vi.fn(),
}))

const appStoreMock = vi.hoisted(() => ({
  selectedModel: 'claude-sonnet-4',
  modelGroups: [] as Array<{ provider: string; models: string[] }>,
  getProviderVisibility: vi.fn(() => ({ mode: 'all', models: [] })),
  setModelVisibility: vi.fn(),
  getModelAlias: vi.fn(() => ''),
  displayModelName: vi.fn((model: string) => model),
  setModelAlias: vi.fn(),
  switchModel: vi.fn(),
}))

const chatStoreMock = vi.hoisted(() => ({
  clearProviderFromSessions: vi.fn(),
}))

const copilotAuthMock = vi.hoisted(() => ({
  checkCopilotToken: vi.fn(),
  disableCopilot: vi.fn(),
}))

const messages: Record<string, string> = {
  'common.delete': 'Delete',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'models.deleteProvider': 'Delete provider',
  'models.deleteConfirm': 'Delete "{name}"?',
  'models.providerDeleted': 'Provider deleted',
  'models.clearProviderCredentials': 'Clear credentials',
  'models.clearCredentialsConfirm': 'Clear stored credentials for "{name}"? This built-in provider will stay listed and can be used again after credentials are configured.',
  'models.providerCredentialsCleared': 'Provider credentials cleared',
  'models.disableProvider': 'Disable provider',
  'models.disableProviderConfirm': 'Disable built-in provider "{name}"? The provider will stay built in and can be enabled again later.',
  'models.providerDisabled': 'Provider disabled',
  'models.defaultProviderUpdated': 'Default provider updated',
  'models.defaultProviderUpdateFailed': 'Failed to update default provider',
  'models.defaultModelUpdated': 'Default model updated',
  'models.defaultModelUpdateFailed': 'Failed to update default model',
  'models.customType': 'Custom',
  'models.builtIn': 'Built-in',
  'models.currentDefault': 'Current default',
  'models.setDefaultProvider': 'Set default provider',
  'models.setDefault': 'Set default',
  'models.provider': 'Provider',
  'models.baseUrl': 'Base URL',
  'models.models': 'Models',
  'models.count': 'models',
  'models.more': 'more',
  'models.aliasManage': 'Manage aliases',
  'models.manageVisibleModels': 'Manage visible models',
  'models.aliasTitleFor': 'Alias {model}',
  'models.defaultShort': 'Default',
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      let value = messages[key] || key
      for (const [name, replacement] of Object.entries(params || {})) {
        value = value.replace(`{${name}}`, String(replacement))
      }
      return value
    },
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    name: 'NButton',
    emits: ['click'],
    setup(_, { slots, emit }) {
      return () => h('button', { onClick: () => emit('click') }, slots.default?.())
    },
  }),
  NCheckbox: defineComponent({
    name: 'NCheckbox',
    setup(_, { slots }) {
      return () => h('label', slots.default?.())
    },
  }),
  NCheckboxGroup: defineComponent({
    name: 'NCheckboxGroup',
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    },
  }),
  NInput: defineComponent({
    name: 'NInput',
    setup() {
      return () => h('input')
    },
  }),
  NModal: defineComponent({
    name: 'NModal',
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    },
  }),
  useMessage: () => messageMock,
  useDialog: () => dialogMock,
}))

vi.mock('@/stores/hermes/models', () => ({ useModelsStore: () => modelsStoreMock }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => appStoreMock }))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => chatStoreMock }))
vi.mock('@/api/hermes/copilot-auth', () => copilotAuthMock)

function provider(overrides: Partial<AvailableModelGroup>): AvailableModelGroup {
  return {
    provider: 'deepseek',
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    models: ['deepseek-chat'],
    api_key: '[stored]',
    builtin: true,
    ...overrides,
  }
}

function mountCard(group: AvailableModelGroup) {
  modelsStoreMock.allProviders = [group]
  return mount(ProviderCard, { props: { provider: group } })
}

describe('ProviderCard built-in destructive action labels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    modelsStoreMock.fetchProviders.mockResolvedValue(undefined)
    modelsStoreMock.setDefaultModel.mockResolvedValue(undefined)
    modelsStoreMock.setDefaultProvider.mockResolvedValue(undefined)
    modelsStoreMock.removeProvider.mockResolvedValue(undefined)
    appStoreMock.switchModel.mockResolvedValue(undefined)
    copilotAuthMock.checkCopilotToken.mockResolvedValue({ source: 'none' })
    copilotAuthMock.disableCopilot.mockResolvedValue(undefined)
  })

  it('shows clear credentials instead of delete for built-in providers', async () => {
    const wrapper = mountCard(provider({ provider: 'deepseek', label: 'DeepSeek', builtin: true }))

    expect(wrapper.text()).toContain('Clear credentials')
    expect(wrapper.text()).not.toContain('Delete provider')

    await wrapper.findAll('button').find(button => button.text() === 'Clear credentials')!.trigger('click')
    expect(dialogMock.warning).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Clear credentials',
      content: expect.stringContaining('will stay listed'),
      positiveText: 'Clear credentials',
    }))

    const dialogOptions = dialogMock.warning.mock.calls[0][0]
    await dialogOptions.onPositiveClick()

    expect(modelsStoreMock.removeProvider).toHaveBeenCalledWith('deepseek', {
      source: undefined,
      providerKey: undefined,
    })
    expect(messageMock.success).toHaveBeenCalledWith('Provider credentials cleared')
  })

  it('keeps clear-credentials wording for built-in providers loaded from config', async () => {
    const wrapper = mountCard(provider({
      provider: 'deepseek',
      label: 'DeepSeek',
      builtin: true,
      provider_source: 'providers',
      provider_key: 'deepseek',
    }))

    expect(wrapper.text()).toContain('Clear credentials')
    expect(wrapper.text()).not.toContain('Delete provider')

    await wrapper.findAll('button').find(button => button.text() === 'Clear credentials')!.trigger('click')
    expect(dialogMock.warning).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Clear credentials',
      positiveText: 'Clear credentials',
    }))
  })

  it('keeps delete wording for config-backed custom providers', async () => {
    const wrapper = mountCard(provider({
      provider: 'custom:subrouter',
      label: 'subrouter',
      builtin: false,
      provider_source: 'custom_providers',
      provider_key: 'subrouter',
    }))

    expect(wrapper.text()).toContain('Delete')
    expect(wrapper.text()).not.toContain('Clear credentials')

    await wrapper.findAll('button').find(button => button.text() === 'Delete')!.trigger('click')
    expect(dialogMock.warning).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete provider',
      content: 'Delete "subrouter"?',
      positiveText: 'Delete',
    }))

    const dialogOptions = dialogMock.warning.mock.calls[0][0]
    await dialogOptions.onPositiveClick()

    expect(modelsStoreMock.removeProvider).toHaveBeenCalledWith('custom:subrouter', {
      source: 'custom_providers',
      providerKey: 'subrouter',
    })
    expect(messageMock.success).toHaveBeenCalledWith('Provider deleted')
  })

  it('keeps delete wording for custom-prefixed providers even when they match a built-in preset', async () => {
    const wrapper = mountCard(provider({
      provider: 'custom:fun-codex',
      label: 'fun-codex',
      builtin: true,
      provider_source: 'custom_providers',
      provider_key: 'fun-codex',
    }))

    expect(wrapper.text()).toContain('Delete')
    expect(wrapper.text()).not.toContain('Clear credentials')

    await wrapper.findAll('button').find(button => button.text() === 'Delete')!.trigger('click')
    expect(dialogMock.warning).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete provider',
      content: 'Delete "fun-codex"?',
      positiveText: 'Delete',
    }))
  })

  it('uses disable wording for Copilot instead of delete', async () => {
    const wrapper = mountCard(provider({ provider: 'copilot', label: 'GitHub Copilot', builtin: true, api_key: '' }))

    expect(wrapper.text()).toContain('Disable provider')
    expect(wrapper.text()).not.toContain('Delete')

    await wrapper.findAll('button').find(button => button.text() === 'Disable provider')!.trigger('click')
    expect(dialogMock.warning).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Disable provider',
      content: expect.stringContaining('Disable built-in provider "GitHub Copilot"'),
      positiveText: 'Disable provider',
    }))

    const dialogOptions = dialogMock.warning.mock.calls[0][0]
    await dialogOptions.onPositiveClick()

    expect(copilotAuthMock.disableCopilot).toHaveBeenCalled()
    expect(messageMock.success).toHaveBeenCalledWith('Provider disabled')
  })

  it('exposes an explicit set-default-provider action on non-default providers', async () => {
    modelsStoreMock.defaultProvider = 'deepseek'
    modelsStoreMock.defaultModel = 'deepseek-chat'
    const wrapper = mountCard(provider({
      provider: 'openai',
      label: 'OpenAI',
      models: ['gpt-4.1'],
    }))

    await wrapper.findAll('button').find(button => button.text() === 'Set default provider')!.trigger('click')

    expect(modelsStoreMock.setDefaultProvider).toHaveBeenCalledWith('openai')
    expect(messageMock.success).toHaveBeenCalledWith('Default provider updated')
  })

  it('exposes an explicit set-default-model action for non-default models', async () => {
    modelsStoreMock.defaultProvider = 'deepseek'
    modelsStoreMock.defaultModel = 'deepseek-chat'
    const wrapper = mountCard(provider({
      provider: 'deepseek',
      label: 'DeepSeek',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    }))

    await wrapper.findAll('button').find(button => button.text() === 'Set default')!.trigger('click')

    expect(modelsStoreMock.setDefaultModel).toHaveBeenCalledWith('deepseek-reasoner', 'deepseek')
    expect(messageMock.success).toHaveBeenCalledWith('Default model updated')
  })
})
