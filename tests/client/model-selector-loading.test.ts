// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import ModelSelector from '@/components/layout/ModelSelector.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const stores = vi.hoisted(() => {
  const appStore = {
    selectedModel: 'old-model',
    selectedProvider: 'test-provider',
    customModels: {} as Record<string, string[]>,
    profileModelGroups: [
      {
        profile: 'default',
        groups: [
          {
            provider: 'test-provider',
            label: 'Test Provider',
            models: ['old-model', 'new-model'],
            model_meta: {},
          },
        ],
      },
    ],
    displayModelName: (model: string) => model === 'new-model' ? 'New Model' : model,
    getModelAlias: () => '',
    removeCustomModel: vi.fn(),
    switchModel: vi.fn(),
    reloadModels: vi.fn(),
  }
  const chatStore = {
    activeSession: {
      id: 'session-1',
      model: 'old-model',
      provider: 'test-provider',
    },
    switchSessionModel: vi.fn(),
  }
  return { appStore, chatStore }
})

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => stores.appStore,
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => stores.chatStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ activeProfileName: 'default' }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'common.loading': 'Loading...',
      'models.title': 'Models',
      'models.refresh': 'Refresh',
      'models.searchPlaceholder': 'Search models...',
      'models.customModelPlaceholder': 'Unlisted model ID',
      'models.customModelHint': 'For provider-supported models not returned by the API; not a display rename. Press Enter to load.',
      'models.aliasCanonical': 'Original ID',
      'models.previewBadge': 'PREVIEW',
      'models.disabledBadge': 'UNAVAILABLE',
      'models.customBadge': 'CUSTOM',
      'models.removeCustomModel': 'Remove this unlisted model',
      'models.disabledTooltip': 'Unavailable',
      'chat.modelSetFailed': 'Failed to set model',
    } as Record<string, string>)[key] || key,
  }),
}))

vi.mock('naive-ui', () => ({
  NModal: defineComponent({
    name: 'NModal',
    props: ['show', 'maskClosable'],
    emits: ['update:show'],
    template: '<div v-if="show" class="n-modal"><slot /></div>',
  }),
  NInput: defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: ['value', 'placeholder', 'disabled'],
    emits: ['update:value', 'keydown'],
    template: '<input class="n-input" :value="value" :placeholder="placeholder" :disabled="disabled" @input="$emit(\'update:value\', $event.target.value)" @keydown="$emit(\'keydown\', $event)" />',
  }),
  NSelect: defineComponent({
    name: 'NSelect',
    inheritAttrs: false,
    props: ['value', 'options', 'disabled'],
    emits: ['update:value'],
    template: '<select class="n-select" :value="value" :disabled="disabled" @change="$emit(\'update:value\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
}))

describe('ModelSelector loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stores.appStore.selectedModel = 'old-model'
    stores.appStore.selectedProvider = 'test-provider'
    stores.chatStore.activeSession = {
      id: 'session-1',
      model: 'old-model',
      provider: 'test-provider',
    }
  })

  it('shows immediate feedback while a session model switch is pending', async () => {
    const pending = deferred<boolean>()
    stores.chatStore.switchSessionModel.mockImplementation((model: string, provider: string) => {
      return pending.promise.then(ok => {
        if (ok) {
          stores.chatStore.activeSession.model = model
          stores.chatStore.activeSession.provider = provider
        }
        return ok
      })
    })

    const wrapper = mount(ModelSelector)
    await wrapper.get('.model-trigger').trigger('click')

    const target = wrapper.findAll('.model-item').find(item => item.text().includes('New Model'))
    expect(target).toBeTruthy()
    await target!.trigger('click')
    await nextTick()

    expect(stores.chatStore.switchSessionModel).toHaveBeenCalledWith('new-model', 'test-provider', 'session-1')
    expect(wrapper.get('.model-trigger').classes()).toContain('switching')
    expect(wrapper.get('.model-trigger').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.model-selection-status').text()).toContain('Loading...')
    expect(wrapper.get('.model-item.switching').text()).toContain('New Model')
    expect(wrapper.find('.model-switch-spinner').exists()).toBe(true)

    pending.resolve(true)
    await pending.promise
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()

    expect(wrapper.find('.n-modal').exists()).toBe(false)
  })
})
