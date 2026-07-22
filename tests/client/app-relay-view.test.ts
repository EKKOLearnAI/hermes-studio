// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const relayApi = vi.hoisted(() => ({
  fetchAppRelayBootstrap: vi.fn(),
  connectAppRelay: vi.fn(),
  refreshAppRelayPairingCode: vi.fn(),
  disconnectAppRelay: vi.fn(),
}))
const authApi = vi.hoisted(() => ({
  fetchAppAuthConfig: vi.fn(),
  loginAppAccount: vi.fn(),
  logoutAppAccount: vi.fn(),
  registerAppAccount: vi.fn(),
  restoreAppAccount: vi.fn(),
  sendAppRegistrationCode: vi.fn(),
}))
const message = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))

vi.mock('@/api/hermes/app-relay', () => relayApi)
vi.mock('@/api/hermes/app-auth', () => authApi)
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join(':')}` : key,
    te: () => false,
  }),
}))
vi.mock('@/components/layout/PageSidebarNav.vue', () => ({
  default: defineComponent({ template: '<nav>APP nav</nav>' }),
}))
vi.mock('@/components/layout/PageSidebarFooter.vue', () => ({
  default: defineComponent({ template: '<footer />' }),
}))
vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    props: ['loading', 'disabled'],
    emits: ['click'],
    template: '<button class="n-button-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  }),
  NCard: defineComponent({ template: '<section><slot /></section>' }),
  NInput: defineComponent({
    props: ['value', 'inputProps'],
    emits: ['update:value'],
    template: '<input v-bind="inputProps" class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NPopconfirm: defineComponent({
    emits: ['positive-click'],
    template: '<div><slot name="trigger" /><slot /></div>',
  }),
  NSpin: defineComponent({ template: '<div><slot /></div>' }),
  NTag: defineComponent({ template: '<span><slot /></span>' }),
  useMessage: () => message,
}))

import AppRelayView from '@/views/hermes/AppRelayView.vue'

const user = {
  id: 7,
  email: 'app@example.com',
  displayName: 'App User',
  avatarUrl: '',
  emailVerified: true,
}

describe('AppRelayView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    relayApi.fetchAppRelayBootstrap.mockResolvedValue({
      relay: {
        connected: false,
        machineId: 'hwui_machine',
        pairingCode: '',
        pairingExpiresAt: 0,
      },
      appAuthBaseUrl: 'http://127.0.0.1:8077',
    })
    relayApi.connectAppRelay.mockResolvedValue({
      connected: true,
      machineId: 'hwui_machine',
      pairingCode: 'ABCD2345',
      pairingExpiresAt: Math.floor(Date.now() / 1000) + 600,
    })
    authApi.restoreAppAccount.mockResolvedValue({ user })
    authApi.fetchAppAuthConfig.mockResolvedValue({
      emailVerificationEnabled: true,
    })
    authApi.sendAppRegistrationCode.mockResolvedValue({ expiresIn: 600, retryAfter: 60 })
  })

  it('connects the independent APP channel only after APP account login', async () => {
    const wrapper = mount(AppRelayView)
    await flushPromises()

    const connectButton = wrapper.findAll('.n-button-stub')
      .find(button => button.text() === 'appRelay.connect')
    expect(connectButton).toBeTruthy()

    await connectButton!.trigger('click')
    await flushPromises()

    expect(relayApi.connectAppRelay).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('ABCD2345')
    expect(message.success).toHaveBeenCalledWith('appRelay.connectedMessage')
    wrapper.unmount()
  })

  it('gates relay controls and sends a registration email code for signed-out users', async () => {
    authApi.restoreAppAccount.mockResolvedValueOnce(null)
    const wrapper = mount(AppRelayView)
    await flushPromises()

    expect(wrapper.text()).toContain('appRelay.accountTitle')
    expect(wrapper.text()).not.toContain('appRelay.connect')
    expect(wrapper.text()).not.toContain('appRelay.subtitle')
    expect(wrapper.find('.page-header .header-title').text()).toBe('appRelay.title')
    expect(wrapper.find('.relay-body').classes()).toContain('relay-body--auth')
    expect(wrapper.findAll('.n-input-stub').map(input => input.attributes('autocomplete')))
      .toEqual(['off', 'new-password'])

    const registerTab = wrapper.findAll('button')
      .find(button => button.text() === 'appRelay.register')
    await registerTab!.trigger('click')
    await wrapper.find('.n-input-stub').setValue('new@example.com')
    const sendButton = wrapper.findAll('.n-button-stub')
      .find(button => button.text() === 'appRelay.sendVerificationCode')
    await sendButton!.trigger('click')
    await flushPromises()

    expect(authApi.sendAppRegistrationCode).toHaveBeenCalledWith(
      'http://127.0.0.1:8077',
      'new@example.com',
    )
    expect(message.success).toHaveBeenCalledWith('appRelay.verificationCodeSent')
    wrapper.unmount()
  })
})
