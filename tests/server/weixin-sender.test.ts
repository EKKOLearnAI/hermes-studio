import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mockPost = vi.hoisted(() => vi.fn())

vi.mock('axios', () => ({
  default: { post: mockPost },
}))

const originalHermesHome = process.env.HERMES_HOME
let hermesHome = ''

async function loadSender() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/services/hermes/weixin-sender')
}

describe('weixin reminder sender', () => {
  beforeEach(() => {
    mockPost.mockReset()
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-weixin-sender-'))
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('reports missing credentials clearly', async () => {
    const { sendWeixinTextReminder } = await loadSender()

    const result = await sendWeixinTextReminder('default', 'hello')

    expect(result).toEqual({ ok: false, error: 'missing_weixin_credentials' })
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('posts text reminders to the configured Weixin base URL', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeFileSync(join(hermesHome, 'profiles', 'research', '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1',
      'WEIXIN_TOKEN=token-1',
      'WEIXIN_HOME_CHANNEL=wxid_user_1',
      'WEIXIN_BASE_URL=https://weixin.invalid',
      '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValueOnce({ data: { ret: 0, msgid: 'm1' } })
    const { sendWeixinTextReminder } = await loadSender()

    const result = await sendWeixinTextReminder('research', '现在最该做：吃午饭')

    expect(result).toEqual({ ok: true })
    expect(mockPost).toHaveBeenCalledWith(
      'https://weixin.invalid/ilink/bot/sendmessage',
      expect.stringContaining('现在最该做：吃午饭'),
      expect.objectContaining({
        timeout: 15000,
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          AuthorizationType: 'ilink_bot_token',
          'iLink-App-Id': 'bot',
        }),
      }),
    )
    const [, body] = mockPost.mock.calls[0]
    expect(JSON.parse(body).msg).toMatchObject({
      to_user_id: 'wxid_user_1',
      message_type: 2,
      message_state: 2,
    })
  })

  it('uses the default iLink base URL when none is configured', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1',
      'WEIXIN_TOKEN=token-1',
      'WEIXIN_HOME_CHANNEL=wxid_user_1',
      '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValueOnce({ data: { ret: 0 } })
    const { sendWeixinTextReminder } = await loadSender()

    await sendWeixinTextReminder('default', 'test')

    expect(mockPost.mock.calls[0][0]).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage')
  })

  it('returns stable provider identity and supports lookup by delivery id', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValueOnce({ data: { ret: 0, msgid: 'provider-message-1' } })
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('default')

    const sent = await sender.send({ deliveryId: 'delivery-1', recipient: 'configured-self', message: '安全提醒' })
    expect(sent).toEqual({ status: 'accepted', providerMessageId: 'provider-message-1' })
    expect(await sender.lookup('delivery-1')).toEqual(sent)
    expect(JSON.parse(mockPost.mock.calls[0][1]).msg.client_id).toBe('delivery-1')

    const afterRestart = createWeixinReceiptSender('default')
    expect(await afterRestart.lookup('delivery-1')).toEqual(sent)
    expect(await afterRestart.send({ deliveryId: 'delivery-1', recipient: 'configured-self', message: '安全提醒' })).toEqual(sent)
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('marks an accepted response without a provider identity as explicitly unverifiable', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValueOnce({ data: { ret: 0 } })
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('default')
    expect(await sender.send({ deliveryId: 'delivery-unverified', recipient: 'configured-self', message: '提醒' }))
      .toEqual({ status: 'unknown', providerMessageId: null })
    expect(await sender.lookup('delivery-unverified')).toEqual({ status: 'unknown', providerMessageId: null })
    const afterCrash = createWeixinReceiptSender('default')
    expect(await afterCrash.send({ deliveryId: 'delivery-unverified', recipient: 'configured-self', message: '提醒' }))
      .toEqual({ status: 'unknown', providerMessageId: null })
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('fails closed instead of resending when the durable attempt journal is corrupt', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    writeFileSync(join(hermesHome, 'weixin-deliveries.sqlite'), '{corrupt', 'utf-8')
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('default')
    expect(await sender.send({ deliveryId: 'delivery-maybe-sent', recipient: 'configured-self', message: '不应重发' }))
      .toEqual({ status: 'unknown', providerMessageId: null })
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('atomically claims one delivery across concurrent sender instances', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mockPost.mockImplementationOnce(async () => { await gate; return { data: { ret: 0, msgid: 'provider-one' } } })
    const { createWeixinReceiptSender } = await loadSender()
    const left = createWeixinReceiptSender('default')
    const right = createWeixinReceiptSender('default')
    const first = left.send({ deliveryId: 'delivery-atomic', recipient: 'configured-self', message: '提醒' })
    const second = right.send({ deliveryId: 'delivery-atomic', recipient: 'configured-self', message: '提醒' })
    await vi.waitFor(() => expect(mockPost).toHaveBeenCalled())
    release(); await Promise.all([first, second])
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('does not persist unsafe provider message identities', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValueOnce({ data: { ret: 0, msgid: 'Authorization: Bearer unsafe-secret-value' } })
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('default')
    expect(await sender.send({ deliveryId: 'delivery-unsafe-id', recipient: 'configured-self', message: '提醒' }))
      .toEqual({ status: 'unknown', providerMessageId: null })
  })
})
