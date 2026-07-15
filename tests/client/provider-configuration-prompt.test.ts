// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mockPush = vi.hoisted(() => vi.fn())
const mockGetApiKey = vi.hoisted(() => vi.fn())
const routeState = vi.hoisted(() => ({
  fullPath: '/hermes/chat',
  name: 'hermes.chat' as string,
}))
const modelsStore = vi.hoisted(() => ({
  providers: [] as Array<{ provider: string }>,
  allProviders: [{ provider: 'openai' }],
  fetchProviders: vi.fn(async () => {}),
}))
const profilesStore = vi.hoisted(() => ({
  activeProfileName: 'work' as string | null,
  fetchProfiles: vi.fn(async () => {}),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: { profile?: string }) => params?.profile ? `${key}:${params.profile}` : key,
  }),
}))

vi.mock('@/api/client', () => ({
  getApiKey: mockGetApiKey,
}))

vi.mock('@/stores/hermes/models', () => ({
  useModelsStore: () => modelsStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStore,
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    NModal: defineComponent({
      props: { show: Boolean, title: String, zIndex: Number },
      setup(props, { slots }) {
        return () => props.show
          ? h('div', { class: 'modal', 'data-z-index': props.zIndex }, [
            h('h2', props.title),
            slots.default?.(),
            h('div', { class: 'modal-actions' }, slots.action?.()),
          ])
          : null
      },
    }),
    NButton: defineComponent({
      emits: ['click'],
      setup(_props, { emit, slots }) {
        return () => h('button', { onClick: () => emit('click') }, slots.default?.())
      },
    }),
  }
})

import ProviderConfigurationPrompt from '@/components/hermes/models/ProviderConfigurationPrompt.vue'

describe('ProviderConfigurationPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetApiKey.mockReturnValue('jwt-token')
    routeState.fullPath = '/hermes/chat'
    routeState.name = 'hermes.chat'
    profilesStore.activeProfileName = 'work'
    modelsStore.providers = []
    modelsStore.allProviders = [{ provider: 'openai' }]
  })

  it('prompts when the current profile has no configured providers', async () => {
    const wrapper = mount(ProviderConfigurationPrompt)
    await flushPromises()

    expect(modelsStore.fetchProviders).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('models.noProviderPromptMessage:work')
    expect(wrapper.find('.modal').attributes('data-z-index')).toBe('4000')

    await wrapper.findAll('button')[1].trigger('click')
    expect(mockPush).toHaveBeenCalledWith({ name: 'hermes.models', query: { addProvider: '1' } })
  })

  it('does not confuse the provider catalog with configured providers', async () => {
    modelsStore.providers = []
    modelsStore.allProviders = [{ provider: 'openai' }]

    const wrapper = mount(ProviderConfigurationPrompt)
    await flushPromises()

    expect(wrapper.find('.modal').exists()).toBe(true)
  })

  it('does not prompt when the current profile has a configured provider', async () => {
    modelsStore.providers = [{ provider: 'openai' }]

    const wrapper = mount(ProviderConfigurationPrompt)
    await flushPromises()

    expect(wrapper.find('.modal').exists()).toBe(false)
  })

  it('prompts again after a fresh page mount when remind later was chosen', async () => {
    const first = mount(ProviderConfigurationPrompt)
    await flushPromises()
    await first.findAll('button')[0].trigger('click')
    expect(first.find('.modal').exists()).toBe(false)
    first.unmount()

    modelsStore.fetchProviders.mockClear()
    const second = mount(ProviderConfigurationPrompt)
    await flushPromises()

    expect(modelsStore.fetchProviders).toHaveBeenCalledOnce()
    expect(second.find('.modal').exists()).toBe(true)
  })

  it('stays out of the way on the model settings page', async () => {
    routeState.fullPath = '/hermes/models?addProvider=1'
    routeState.name = 'hermes.models'

    const wrapper = mount(ProviderConfigurationPrompt)
    await flushPromises()

    expect(modelsStore.fetchProviders).not.toHaveBeenCalled()
    expect(wrapper.find('.modal').exists()).toBe(false)
  })
})
