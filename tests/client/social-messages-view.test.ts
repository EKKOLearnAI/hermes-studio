// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const {
  clearCredentials,
  fetchFeishuQrCode,
  fetchFeishuRecipients,
  fetchPlatforms,
  fetchQrCode,
  fetchRecipients,
  fetchTelegramRecipients,
  pollFeishuQrStatus,
  pollQrStatus,
  saveCredentials,
  saveWeixin,
  sendMessage,
  setActivePlatform,
  updateNotificationLocale,
  switchLocale,
  messageApi,
  qrToDataUrl,
  localeState,
} = vi.hoisted(() => ({
  clearCredentials: vi.fn(),
  fetchFeishuQrCode: vi.fn(),
  fetchFeishuRecipients: vi.fn(),
  fetchPlatforms: vi.fn(),
  fetchQrCode: vi.fn(),
  fetchRecipients: vi.fn(),
  fetchTelegramRecipients: vi.fn(),
  pollQrStatus: vi.fn(),
  pollFeishuQrStatus: vi.fn(),
  saveCredentials: vi.fn(),
  saveWeixin: vi.fn(),
  sendMessage: vi.fn(),
  setActivePlatform: vi.fn(),
  updateNotificationLocale: vi.fn(),
  switchLocale: vi.fn(),
  qrToDataUrl: vi.fn(),
  localeState: { __v_isRef: true, value: 'en' },
  messageApi: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/api/social-messages', () => ({
  clearSocialMessageCredentials: clearCredentials,
  fetchFeishuQrCode,
  fetchFeishuRecipients,
  fetchSocialMessagePlatforms: fetchPlatforms,
  fetchTelegramRecipients,
  fetchWeixinQrCode: fetchQrCode,
  fetchWeixinRecipients: fetchRecipients,
  pollFeishuQrStatus,
  pollWeixinQrStatus: pollQrStatus,
  saveSocialMessageCredentials: saveCredentials,
  saveWeixinCredentials: saveWeixin,
  sendSocialMessage: sendMessage,
  setActiveSocialMessagePlatform: setActivePlatform,
  updateSocialMessageNotificationLocale: updateNotificationLocale,
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: qrToDataUrl },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.count == null ? key : `${key}:${values.count}`,
    locale: localeState,
  }),
}))

vi.mock('@/i18n', () => ({ switchLocale }))

vi.mock('naive-ui', () => {
  const Slot = defineComponent({ setup(_props, { slots }) { return () => h('div', slots.default?.()) } })
  const NButton = defineComponent({
    props: { disabled: Boolean, loading: Boolean, attrType: String },
    emits: ['click'],
    setup(props, { emit, slots }) {
      return () => h('button', {
        type: props.attrType || 'button',
        disabled: props.disabled || props.loading,
        onClick: () => emit('click'),
      }, slots.default?.())
    },
  })
  const NInput = defineComponent({
    props: { value: String, type: String, placeholder: String },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h(props.type === 'textarea' ? 'textarea' : 'input', {
        value: props.value,
        placeholder: props.placeholder,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      })
    },
  })
  const NSelect = defineComponent({
    props: {
      value: String,
      options: Array,
      size: { type: String, default: 'medium' },
    },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('select', {
        value: props.value,
        'data-size': props.size,
        onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
      }, (props.options as Array<{ label: string; value: string }> || []).map(option => (
        h('option', { value: option.value }, option.label)
      )))
    },
  })
  const NForm = defineComponent({
    emits: ['submit'],
    setup(_props, { emit, slots }) {
      return () => h('form', { onSubmit: (event: Event) => { event.preventDefault(); emit('submit', event) } }, slots.default?.())
    },
  })
  return {
    NAlert: Slot,
    NButton,
    NCard: Slot,
    NForm,
    NFormItem: Slot,
    NInput,
    NSelect,
    NSpace: Slot,
    NSpin: Slot,
    NTag: Slot,
    useMessage: () => messageApi,
  }
})

import SocialMessagesView from '@/views/social-messages/SocialMessagesView.vue'

describe('SocialMessagesView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localeState.value = 'en'
    switchLocale.mockImplementation(async (value: string) => {
      localeState.value = value
    })
    fetchPlatforms.mockResolvedValue([
      {
        id: 'telegram', configured: true, recipientTypes: ['chat_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 4096, supportsContextToken: false,
      },
      {
        id: 'feishu', configured: false, recipientTypes: ['chat_id', 'open_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 20000, supportsContextToken: false,
      },
    ])
    sendMessage.mockResolvedValue({
      platform: 'telegram', recipient: '1234', messageId: '42', sentAt: '2026-08-23T00:00:00.000Z',
    })
    setActivePlatform.mockResolvedValue(undefined)
    updateNotificationLocale.mockResolvedValue(undefined)
    fetchQrCode.mockResolvedValue({ qrcode: 'qr-id', qrcode_url: 'https://weixin.example/authorize' })
    fetchFeishuQrCode.mockResolvedValue({
      session_id: 'feishu-session',
      qrcode_url: 'https://accounts.feishu.cn/device?code=scan',
      poll_interval_ms: 3_000,
      expires_in_ms: 600_000,
    })
    fetchRecipients.mockResolvedValue({ recipients: [], runtimeStatus: 'running' })
    fetchTelegramRecipients.mockResolvedValue({
      recipients: [{ chatId: '1234', chatType: 'private', lastSeenAt: '2026-08-23T00:00:00.000Z' }],
      runtimeStatus: 'running',
    })
    fetchFeishuRecipients.mockResolvedValue({ recipients: [], runtimeStatus: 'running' })
    qrToDataUrl.mockImplementation((value: string) => Promise.resolve(
      `data:image/png;base64,${value.includes('feishu') ? 'feishu' : 'weixin'}-qr`,
    ))
  })

  it('loads configured platforms and sends through the unified API', async () => {
    const wrapper = mount(SocialMessagesView, {
      global: {
        stubs: {
          RouterLink: defineComponent({ setup(_props, { slots }) { return () => h('a', slots.default?.()) } }),
        },
      },
    })
    await flushPromises()

    expect(fetchPlatforms).toHaveBeenCalledTimes(1)
    const textarea = wrapper.get('textarea')
    await textarea.setValue('hello telegram')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(sendMessage).toHaveBeenCalledWith({
      platform: 'telegram',
      recipient: '1234',
      recipientType: 'chat_id',
      content: 'hello telegram',
      contextToken: undefined,
    })
    expect(messageApi.success).toHaveBeenCalledWith('socialMessages.sent')
    expect(wrapper.text()).toContain('42')
  })

  it('polls Telegram until an inbound message identifies the push target', async () => {
    vi.useFakeTimers()
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'telegram', configured: true, recipientTypes: ['chat_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 4096, supportsContextToken: false,
      },
    ])
    fetchTelegramRecipients
      .mockResolvedValueOnce({ recipients: [], runtimeStatus: 'running' })
      .mockResolvedValueOnce({
        recipients: [{ chatId: '5678', chatType: 'private', lastSeenAt: '2026-08-23T00:00:00.000Z' }],
        runtimeStatus: 'running',
      })
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()

      expect(fetchTelegramRecipients).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).toContain('socialMessages.telegramPushAwaitingFirstMessage')
      expect(wrapper.find('textarea').exists()).toBe(false)
      expect(wrapper.find('input[placeholder="socialMessages.recipientPlaceholders.telegram"]').exists()).toBe(false)

      await vi.advanceTimersByTimeAsync(2_000)
      await flushPromises()

      expect(fetchTelegramRecipients).toHaveBeenCalledTimes(2)
      expect(wrapper.text()).toContain('socialMessages.telegramPushReady')
      await wrapper.get('textarea').setValue('hello telegram')
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(sendMessage).toHaveBeenCalledWith({
        platform: 'telegram',
        recipient: '5678',
        recipientType: 'chat_id',
        content: 'hello telegram',
        contextToken: undefined,
      })
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('opens the persisted active medium and marks a newly selected configured medium active', async () => {
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'telegram', configured: true, active: false, recipientTypes: ['chat_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 4096, supportsContextToken: false,
      },
      {
        id: 'feishu', configured: true, active: true, recipientTypes: ['chat_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 20000, supportsContextToken: false,
      },
    ])
    const wrapper = mount(SocialMessagesView)
    await flushPromises()

    const select = wrapper.get('[data-testid="social-messages-platform"]')
    expect((select.element as HTMLSelectElement).value).toBe('feishu')
    expect(setActivePlatform).not.toHaveBeenCalled()

    await select.setValue('telegram')
    await flushPromises()
    expect(setActivePlatform).toHaveBeenCalledWith('telegram')
  })

  it('orders the platform selector as Weixin, Feishu, then Telegram', async () => {
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'telegram', configured: true, recipientTypes: ['chat_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 4096, supportsContextToken: false,
      },
      {
        id: 'weixin', configured: true, recipientTypes: ['user_id'], defaultRecipientType: 'user_id',
        maxContentLength: 2000, supportsContextToken: true,
      },
      {
        id: 'feishu', configured: true, recipientTypes: ['chat_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 20000, supportsContextToken: false,
      },
    ])
    const wrapper = mount(SocialMessagesView)
    await flushPromises()

    expect(wrapper.get('[data-testid="social-messages-platform"]').findAll('option').map(option => option.attributes('value'))).toEqual([
      'weixin',
      'feishu',
      'telegram',
    ])
  })

  it('keeps push language independent from the frontend locale and persists changes immediately', async () => {
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'telegram', configured: true, active: true, notificationLocale: 'ja',
        recipientTypes: ['chat_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 4096, supportsContextToken: false,
      },
    ])
    const wrapper = mount(SocialMessagesView)
    await flushPromises()

    const languageSelect = wrapper.get('[data-testid="social-messages-language"]')
    const platformSelect = wrapper.get('[data-testid="social-messages-platform"]')
    expect(languageSelect.element.compareDocumentPosition(platformSelect.element) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(languageSelect.attributes('data-size')).toBe('medium')
    expect(languageSelect.attributes('data-size')).toBe(platformSelect.attributes('data-size'))
    expect((languageSelect.element as HTMLSelectElement).value).toBe('ja')
    expect(localeState.value).toBe('en')

    await languageSelect.setValue('zh')
    await flushPromises()
    expect(updateNotificationLocale).toHaveBeenCalledWith('telegram', 'zh')
    expect(switchLocale).not.toHaveBeenCalled()
    expect(localeState.value).toBe('en')
  })

  it('embeds in the App connections panel without a duplicate page header', async () => {
    const wrapper = mount(SocialMessagesView, {
      props: { embedded: true },
    })
    await flushPromises()

    expect(wrapper.classes()).toContain('social-messages-view--embedded')
    expect(wrapper.find('.page-header').exists()).toBe(false)
  })

  it('shows only the QR code when the selected Weixin account is not configured', async () => {
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'weixin', configured: false, recipientTypes: ['user_id'], defaultRecipientType: 'user_id',
        maxContentLength: 2000, supportsContextToken: true,
      },
    ])
    const wrapper = mount(SocialMessagesView, {
      global: {
        stubs: {
          RouterLink: defineComponent({ setup(_props, { slots }) { return () => h('a', slots.default?.()) } }),
        },
      },
    })
    await flushPromises()

    expect(fetchQrCode).toHaveBeenCalledTimes(1)
    expect(qrToDataUrl).toHaveBeenCalledWith('https://weixin.example/authorize', expect.objectContaining({ width: 280 }))
    expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,weixin-qr')
    expect(wrapper.find('input[placeholder="socialMessages.weixinAccountIdPlaceholder"]').exists()).toBe(false)
    expect(wrapper.find('input[placeholder="socialMessages.secretReplacementPlaceholder"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('saves the selected language for the first Telegram binding notification', async () => {
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'telegram', configured: false, recipientTypes: ['chat_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 4096, supportsContextToken: false,
      },
    ])
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()
      expect(wrapper.text()).not.toContain('socialMessages.configureFirst')
      await wrapper.get('[data-testid="social-messages-language"]').setValue('zh')
      expect(updateNotificationLocale).not.toHaveBeenCalled()
      expect(localeState.value).toBe('en')
      await wrapper.get('input[placeholder="socialMessages.secretReplacementPlaceholder"]').setValue('123456:token')
      const saveButton = wrapper.findAll('button').find(button => button.text() === 'socialMessages.saveCredentials')
      expect(saveButton).toBeDefined()
      await saveButton!.trigger('click')
      await flushPromises()

      expect(saveCredentials).toHaveBeenCalledWith('telegram', {
        botToken: '123456:token',
        locale: 'zh',
      })
    } finally {
      wrapper.unmount()
    }
  })

  it('saves the selected language after Weixin QR confirmation', async () => {
    vi.useFakeTimers()
    localeState.value = 'ja'
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'weixin', configured: false, recipientTypes: ['user_id'], defaultRecipientType: 'user_id',
        maxContentLength: 2000, supportsContextToken: true,
      },
    ])
    pollQrStatus.mockResolvedValueOnce({
      status: 'confirmed',
      account_id: 'weixin-bot',
      token: 'weixin-token',
      user_id: 'weixin-user',
    })
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(2_000)
      await flushPromises()

      expect(saveWeixin).toHaveBeenCalledWith({
        account_id: 'weixin-bot',
        token: 'weixin-token',
        base_url: undefined,
        user_id: 'weixin-user',
        locale: 'ja',
      })
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('hides the QR code after it is scanned while waiting for phone confirmation', async () => {
    vi.useFakeTimers()
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'weixin', configured: false, recipientTypes: ['user_id'], defaultRecipientType: 'user_id',
        maxContentLength: 2000, supportsContextToken: true,
      },
    ])
    pollQrStatus.mockResolvedValueOnce({ status: 'scaned' })
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()
      expect(wrapper.find('img').exists()).toBe(true)

      await vi.advanceTimersByTimeAsync(2_000)
      await flushPromises()

      expect(wrapper.find('img').exists()).toBe(false)
      expect(wrapper.text()).toContain('socialMessages.weixinQrScanned')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('polls for a Weixin push target and warns until a user has sent the bot a message', async () => {
    vi.useFakeTimers()
    fetchPlatforms.mockResolvedValue([
      {
        id: 'weixin', configured: true, recipientTypes: ['user_id'], defaultRecipientType: 'user_id',
        maxContentLength: 2000, supportsContextToken: true,
      },
    ])
    fetchRecipients
      .mockResolvedValueOnce({ recipients: [], runtimeStatus: 'running' })
      .mockResolvedValueOnce({
        recipients: [{ userId: 'wx-user-1', lastSeenAt: '2026-08-23T00:00:00.000Z', hasContextToken: true }],
        runtimeStatus: 'running',
      })
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()

      expect(fetchRecipients).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).toContain('socialMessages.weixinPushAwaitingFirstMessage')
      expect(wrapper.find('.weixin-toolbar .weixin-status-line--warning').exists()).toBe(true)
      expect(wrapper.find('textarea').exists()).toBe(false)
      expect(saveCredentials).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await flushPromises()

      expect(fetchRecipients).toHaveBeenCalledTimes(2)
      expect(wrapper.text()).toContain('socialMessages.weixinPushReady')
      expect(wrapper.find('.weixin-target').exists()).toBe(false)
      expect(wrapper.find('textarea').exists()).toBe(true)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('does not keep polling Weixin when a push target already exists', async () => {
    vi.useFakeTimers()
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'weixin', configured: true, recipientTypes: ['user_id'], defaultRecipientType: 'user_id',
        maxContentLength: 2000, supportsContextToken: true,
      },
    ])
    fetchRecipients.mockResolvedValueOnce({
      recipients: [{ userId: 'known-user', lastSeenAt: '2026-08-23T00:00:00.000Z', hasContextToken: true }],
      runtimeStatus: 'running',
    })
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(6_000)
      await flushPromises()

      expect(fetchRecipients).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).toContain('socialMessages.weixinPushReady')
      expect(wrapper.find('textarea').exists()).toBe(true)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('shows an expired-session error without exposing a stale push target', async () => {
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'weixin', configured: true, recipientTypes: ['user_id'], defaultRecipientType: 'user_id',
        maxContentLength: 2000, supportsContextToken: true,
      },
    ])
    fetchRecipients.mockResolvedValueOnce({
      recipients: [{ userId: 'stale-user', lastSeenAt: '2026-08-22T00:00:00.000Z', hasContextToken: true }],
      runtimeStatus: 'error',
      runtimeError: 'session timeout (ret=0, errcode=-14)',
    })
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()

      expect(wrapper.text()).toContain('socialMessages.weixinSessionExpired')
      expect(wrapper.find('.weixin-toolbar .weixin-status-line--error').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('socialMessages.weixinPushReady')
      expect(wrapper.find('textarea').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('clears a configured Weixin account and returns to QR login', async () => {
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'weixin', configured: true, recipientTypes: ['user_id'], defaultRecipientType: 'user_id',
        maxContentLength: 2000, supportsContextToken: true,
      },
    ])
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()
      const clearButton = wrapper.findAll('button').find(button => (
        button.text() === 'socialMessages.weixinClearCredentials'
      ))
      expect(clearButton).toBeDefined()

      await clearButton!.trigger('click')
      await flushPromises()

      expect(clearCredentials).toHaveBeenCalledWith('weixin')
      expect(messageApi.success).toHaveBeenCalledWith('socialMessages.weixinCredentialsCleared')
      expect(fetchQrCode).toHaveBeenCalledTimes(1)
      expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,weixin-qr')
    } finally {
      wrapper.unmount()
    }
  })

  it('creates and connects an unconfigured Feishu app by QR code without exposing credential fields', async () => {
    vi.useFakeTimers()
    localeState.value = 'zh-TW'
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'feishu', configured: false, recipientTypes: ['chat_id', 'open_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 20000, supportsContextToken: false,
      },
    ])
    pollFeishuQrStatus.mockResolvedValueOnce({ status: 'confirmed', open_id: 'ou_owner' })
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()

      expect(fetchFeishuQrCode).toHaveBeenCalledWith('zh-TW')
      expect(qrToDataUrl).toHaveBeenCalledWith(
        'https://accounts.feishu.cn/device?code=scan',
        expect.objectContaining({ width: 280 }),
      )
      expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,feishu-qr')
      expect(wrapper.find('input[placeholder="socialMessages.feishuAppId"]').exists()).toBe(false)
      expect(wrapper.find('input[placeholder="socialMessages.secretReplacementPlaceholder"]').exists()).toBe(false)

      await wrapper.get('[data-testid="social-messages-language"]').setValue('ja')
      expect(localeState.value).toBe('zh-TW')
      await vi.advanceTimersByTimeAsync(3_000)
      await flushPromises()

      expect(pollFeishuQrStatus).toHaveBeenCalledWith('feishu-session', 'ja')
      expect(saveCredentials).not.toHaveBeenCalled()
      expect(fetchFeishuRecipients).toHaveBeenCalledTimes(1)
      expect(messageApi.success).toHaveBeenCalledWith('socialMessages.feishuQrSaved')
      expect(wrapper.text()).toContain('socialMessages.feishuPushAwaitingFirstMessage')
      expect(wrapper.find('input[placeholder="socialMessages.recipientPlaceholders.feishu"]').exists()).toBe(false)
      expect(wrapper.findAll('select')).toHaveLength(2)
      expect(wrapper.find('textarea').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('polls Feishu until a message identifies the target, hides target fields, and sends to that chat', async () => {
    vi.useFakeTimers()
    fetchPlatforms.mockResolvedValueOnce([
      {
        id: 'feishu', configured: true, recipientTypes: ['chat_id', 'open_id'], defaultRecipientType: 'chat_id',
        maxContentLength: 20000, supportsContextToken: false,
      },
    ])
    fetchFeishuRecipients
      .mockResolvedValueOnce({ recipients: [], runtimeStatus: 'running' })
      .mockResolvedValueOnce({
        recipients: [{ chatId: 'oc_recent', chatType: 'p2p', lastSeenAt: '2026-08-23T00:00:00.000Z' }],
        runtimeStatus: 'running',
      })
    sendMessage.mockResolvedValueOnce({
      platform: 'feishu', recipient: 'oc_recent', messageId: 'om_1', sentAt: '2026-08-23T00:00:00.000Z',
    })
    const wrapper = mount(SocialMessagesView)
    try {
      await flushPromises()

      expect(wrapper.text()).toContain('socialMessages.feishuPushAwaitingFirstMessage')
      expect(wrapper.findAll('select')).toHaveLength(2)
      expect(wrapper.find('input[placeholder="socialMessages.recipientPlaceholders.feishu"]').exists()).toBe(false)

      await vi.advanceTimersByTimeAsync(2_000)
      await flushPromises()

      expect(fetchFeishuRecipients).toHaveBeenCalledTimes(2)
      expect(wrapper.text()).toContain('socialMessages.feishuPushReady')
      await wrapper.get('textarea').setValue('hello feishu')
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(sendMessage).toHaveBeenCalledWith({
        platform: 'feishu',
        recipient: 'oc_recent',
        recipientType: 'chat_id',
        content: 'hello feishu',
        contextToken: undefined,
      })

      await vi.advanceTimersByTimeAsync(4_000)
      expect(fetchFeishuRecipients).toHaveBeenCalledTimes(2)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })
})
