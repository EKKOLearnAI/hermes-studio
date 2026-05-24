// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockPush = vi.hoisted(() => vi.fn())
const mockFetchCurrentUser = vi.hoisted(() => vi.fn())
const mockGetApiKey = vi.hoisted(() => vi.fn())
const routeState = vi.hoisted(() => ({ fullPath: '/hermes/chat', name: 'hermes.chat' as any }))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/api/auth', () => ({
  fetchCurrentUser: mockFetchCurrentUser,
}))

vi.mock('@/api/client', () => ({
  getApiKey: mockGetApiKey,
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    NModal: defineComponent({
      props: { show: Boolean, title: String },
      setup(props, { slots }) {
        return () => props.show
          ? h('div', { class: 'modal' }, [
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

import DefaultCredentialPrompt from '@/components/auth/DefaultCredentialPrompt.vue'

describe('DefaultCredentialPrompt', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
    routeState.fullPath = '/hermes/chat'
    routeState.name = 'hermes.chat'
    mockGetApiKey.mockReturnValue('jwt-token')
  })

  it('prompts after login when the current user still has default credentials', async () => {
    mockFetchCurrentUser.mockResolvedValue({
      id: 1,
      username: 'admin',
      role: 'super_admin',
      status: 'active',
      created_at: 1,
      updated_at: 1,
      last_login_at: 1,
      requiresCredentialChange: true,
    })

    const wrapper = mount(DefaultCredentialPrompt)
    await flushPromises()
    await nextTick()

    expect(mockFetchCurrentUser).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('login.defaultCredentialMessage')
    await wrapper.findAll('button')[1].trigger('click')
    expect(mockPush).toHaveBeenCalledWith({ name: 'hermes.settings', query: { tab: 'account' } })
  })

  it('does not prompt on the login route', async () => {
    routeState.fullPath = '/'
    routeState.name = 'login'

    mount(DefaultCredentialPrompt)
    await Promise.resolve()

    expect(mockFetchCurrentUser).not.toHaveBeenCalled()
  })
})
