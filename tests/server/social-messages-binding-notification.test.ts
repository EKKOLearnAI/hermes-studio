import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
const database = vi.hoisted(() => ({ value: null as any }))

vi.mock('../../packages/server/src/db/index', () => ({ getDb: () => database.value }))
vi.mock('../../packages/server/src/services/social-messages/service', () => ({
  getSocialMessageService: () => ({ send }),
}))

describe('Social Messages first binding notification', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    send.mockResolvedValue({ platform: 'telegram', recipient: '1234', messageId: '1' })
    const { DatabaseSync } = await import('node:sqlite')
    database.value = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    database.value?.close()
    database.value = null
    vi.resetModules()
  })

  it('binds the first sender and pushes a localized success message only once', async () => {
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    store.upsertSocialMessageAccount({
      userId: 7,
      platform: 'telegram',
      credentials: { botToken: '123456:token' },
      active: true,
      bindingLocale: 'zh',
    })
    const notification = await import(
      '../../packages/server/src/services/social-messages/binding-notification'
    )
    const input = {
      userId: 7,
      platform: 'telegram' as const,
      recipient: '1234',
      recipientType: 'chat_id' as const,
    }

    await expect(notification.notifyFirstSocialMessageBinding(input)).resolves.toBe(true)
    await expect(notification.notifyFirstSocialMessageBinding(input)).resolves.toBe(false)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(7, {
      platform: 'telegram',
      recipient: '1234',
      recipientType: 'chat_id',
      content: '✅ 通知绑定成功',
    })
    expect(store.getActiveSocialMessageAccount(7)).toMatchObject({
      platform: 'telegram',
      recipient: '1234',
      recipientType: 'chat_id',
      bindingNotified: true,
    })
  })

  it('retries on the next inbound message when the success notification fails', async () => {
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    store.upsertSocialMessageAccount({
      userId: 7,
      platform: 'weixin',
      credentials: { accountId: 'bot', token: 'token', baseUrl: 'https://weixin.example' },
      active: true,
      bindingLocale: 'en',
    })
    send.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce({})
    const notification = await import(
      '../../packages/server/src/services/social-messages/binding-notification'
    )
    const input = {
      userId: 7,
      platform: 'weixin' as const,
      recipient: 'wx-user',
      recipientType: 'user_id' as const,
      contextToken: 'context',
    }

    await expect(notification.notifyFirstSocialMessageBinding(input)).resolves.toBe(false)
    expect(store.getSocialMessageAccount(7, 'weixin')?.bindingNotified).toBe(false)
    await expect(notification.notifyFirstSocialMessageBinding(input)).resolves.toBe(true)
    expect(send).toHaveBeenLastCalledWith(7, expect.objectContaining({
      content: '✅ Weixin notifications are connected.\n\nDue to Weixin conversation limits, notifications may temporarily stop after a long period without interaction or several consecutive notifications. If that happens, send the bot any message to restore notifications.',
      contextToken: 'context',
    }))
  })

  it('formats every selectable locale and falls back to English', async () => {
    const { formatBindingSuccessMessage } = await import(
      '../../packages/server/src/services/social-messages/binding-notification'
    )
    const expected = {
      zh: '✅ 通知绑定成功',
      'zh-TW': '✅ 通知綁定成功',
      en: '✅ Notification binding successful',
      ja: '✅ 通知の連携に成功しました',
      ko: '✅ 알림 연결에 성공했습니다',
      fr: '✅ Liaison des notifications réussie',
      es: '✅ Vinculación de notificaciones completada',
      de: '✅ Benachrichtigungen erfolgreich verknüpft',
      pt: '✅ Vinculação de notificações concluída',
      ru: '✅ Уведомления успешно привязаны',
      ar: '✅ تم ربط الإشعارات بنجاح',
    }
    expect(Object.fromEntries(
      Object.keys(expected).map(locale => [locale, formatBindingSuccessMessage(locale)]),
    )).toEqual(expected)
    expect(formatBindingSuccessMessage('unsupported')).toBe(expected.en)
    expect(formatBindingSuccessMessage('zh', 'weixin')).toBe(
      '✅ 微信推送已绑定成功。\n\n受微信会话机制限制，长时间未互动或连续推送多条消息后，推送可能暂时失效；如未收到后续通知，请主动给机器人发送任意消息以恢复推送。',
    )
    expect(formatBindingSuccessMessage('unsupported', 'weixin')).toBe(
      '✅ Weixin notifications are connected.\n\nDue to Weixin conversation limits, notifications may temporarily stop after a long period without interaction or several consecutive notifications. If that happens, send the bot any message to restore notifications.',
    )
  })
})
