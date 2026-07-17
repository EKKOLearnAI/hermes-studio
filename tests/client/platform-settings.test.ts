// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const {
  mockClearCredentials,
  mockDialogWarning,
  mockMessage,
  mockSettingsStore,
} = vi.hoisted(() => ({
  mockClearCredentials: vi.fn(),
  mockDialogWarning: vi.fn(),
  mockMessage: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
  mockSettingsStore: {
    loading: false,
    saving: false,
    display: {},
    agent: {},
    memory: {},
    skills: {},
    compression: {},
    sessionReset: {},
    privacy: {},
    approvals: {},
    gatewayAutoStart: {},
    proxy: {},
    telegram: {},
    discord: {},
    slack: {},
    whatsapp: {},
    matrix: {},
    wecom: {},
    feishu: {},
    dingtalk: {},
    qqbot: {},
    weixin: {},
    platforms: {
      telegram: { token: 'telegram-token' },
      discord: {},
      slack: {},
      whatsapp: {},
      matrix: {},
      feishu: {},
      dingtalk: {},
      qqbot: {},
      weixin: {},
      wecom: {},
    },
    platformCredentialStatus: {
      telegram: true,
      discord: false,
      slack: false,
      matrix: false,
      weixin: false,
      wecom: false,
      feishu: false,
      dingtalk: false,
      qqbot: false,
    },
    fetchSettings: vi.fn(),
    saveSection: vi.fn(),
  },
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/api/hermes/config', () => ({
  clearCredentials: mockClearCredentials,
  saveCredentials: vi.fn(),
  fetchWeixinQrCode: vi.fn(),
  pollWeixinQrStatus: vi.fn(),
  saveWeixinCredentials: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  const NButton = defineComponent({
    props: {
      disabled: Boolean,
      loading: Boolean,
      type: { type: String, default: '' },
    },
    emits: ['click'],
    setup(props, { emit, slots }) {
      return () => h('button', {
        type: 'button',
        disabled: props.disabled,
        'data-button-type': props.type,
        onClick: () => emit('click'),
      }, slots.default?.())
    },
  })
  const NInput = defineComponent({
    props: {
      value: { type: String, default: '' },
    },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('input', {
        value: props.value,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      })
    },
  })
  const NSwitch = defineComponent({
    props: {
      value: { type: [Boolean, String], default: false },
    },
    emits: ['update:value'],
    setup() {
      return () => h('input', { type: 'checkbox' })
    },
  })
  const NSpin = defineComponent({
    setup(_props, { slots }) {
      return () => h('div', slots.default?.())
    },
  })
  const NTag = defineComponent({
    setup(_props, { slots }) {
      return () => h('span', slots.default?.())
    },
  })
  const NAlert = defineComponent({
    setup(_props, { slots }) {
      return () => h('div', slots.default?.())
    },
  })
  return {
    NButton,
    NInput,
    NSwitch,
    NSpin,
    NTag,
    NAlert,
    useDialog: () => ({ warning: mockDialogWarning }),
    useMessage: () => mockMessage,
  }
})

import PlatformSettings from '@/components/hermes/settings/PlatformSettings.vue'

const platformCardStub = defineComponent({
  props: ['name', 'platformKey', 'config', 'credentials', 'exclusive'],
  template: '<div class="platform-card"><slot /></div>',
})
const settingRowStub = defineComponent({
  props: ['label', 'hint'],
  template: '<div class="setting-row"><span>{{ label }}</span><slot /></div>',
})

function mountSettings() {
  return mount(PlatformSettings, {
    global: {
      stubs: {
        PlatformCard: platformCardStub,
        SettingRow: settingRowStub,
      },
    },
  })
}

function clearButtons(wrapper: ReturnType<typeof mountSettings>) {
  return wrapper.findAll('button').filter(button => button.text() === 'platform.clearCredentials')
}

describe('PlatformSettings credential clearing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.platformCredentialStatus.telegram = true
    mockSettingsStore.platforms.telegram = { token: 'telegram-token' }
    mockSettingsStore.fetchSettings.mockResolvedValue(undefined)
    mockClearCredentials.mockResolvedValue({
      success: true,
      platform: 'telegram',
      clearedPaths: ['token'],
      gatewayRestarted: true,
    })
  })

  it('requires confirmation and clears the active platform credentials', async () => {
    const wrapper = mountSettings()
    const buttons = clearButtons(wrapper)

    expect(buttons.length).toBe(10)
    expect(buttons[0].attributes('disabled')).toBeUndefined()
    // WhatsApp has no explicit credential allowlist and must fail closed in the UI.
    expect(buttons[3].attributes('disabled')).toBeDefined()

    await buttons[0].trigger('click')
    expect(mockDialogWarning).toHaveBeenCalledTimes(1)
    expect(mockClearCredentials).not.toHaveBeenCalled()

    const dialogOptions = mockDialogWarning.mock.calls[0][0]
    await dialogOptions.onPositiveClick()
    await flushPromises()

    expect(mockClearCredentials).toHaveBeenCalledWith('telegram')
    expect(mockSettingsStore.fetchSettings).toHaveBeenCalled()
    expect(mockMessage.success).toHaveBeenCalledWith('platform.credentialsCleared')
  })

  it('shows a localized warning when the gateway restart fails after clearing', async () => {
    mockClearCredentials.mockResolvedValueOnce({
      success: true,
      platform: 'telegram',
      clearedPaths: ['token'],
      gatewayRestarted: false,
      warning: {
        code: 'gateway_restart_failed',
        message: 'server fallback message',
      },
    })
    const wrapper = mountSettings()
    await clearButtons(wrapper)[0].trigger('click')
    const dialogOptions = mockDialogWarning.mock.calls[0][0]
    await dialogOptions.onPositiveClick()
    await flushPromises()

    expect(mockMessage.warning).toHaveBeenCalledWith('platform.clearCredentialsGatewayRestartFailed')
  })

  it('blocks clearing while the channel has an unsaved credential draft', async () => {
    const wrapper = mountSettings()
    const tokenInput = wrapper.find('input')
    await tokenInput.setValue('new-unsaved-token')

    await clearButtons(wrapper)[0].trigger('click')

    expect(mockMessage.warning).toHaveBeenCalledWith('platform.clearCredentialsUnsaved')
    expect(mockDialogWarning).not.toHaveBeenCalled()
    expect(mockClearCredentials).not.toHaveBeenCalled()
  })
})
