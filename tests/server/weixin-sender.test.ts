import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'

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

function boundRequest(sender: { identity?(): { accountFingerprint: string } | null }, deliveryId: string, message: string) {
  return { deliveryId, recipient: 'configured-self' as const, message,
    expectedAccountFingerprint: sender.identity?.()?.accountFingerprint ?? '0'.repeat(64) }
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

  it('never falls a missing named profile back to default credentials', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=default-account', 'WEIXIN_TOKEN=default-token', 'WEIXIN_HOME_CHANNEL=default-home', '',
    ].join('\n'), 'utf-8')
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('missing-profile')

    expect(sender.identity?.()).toBeNull()
    expect(await sender.send(boundRequest(sender, 'missing-profile-delivery', '提醒')))
      .toEqual({ status: 'unknown', providerMessageId: null })
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

    const sent = await sender.send(boundRequest(sender, 'delivery-1', '安全提醒'))
    expect(sent).toEqual({ status: 'accepted', providerMessageId: 'provider-message-1' })
    expect(await sender.lookup('delivery-1')).toEqual(sent)
    expect(JSON.parse(mockPost.mock.calls[0][1]).msg.client_id).toBe('delivery-1')

    const afterRestart = createWeixinReceiptSender('default')
    expect(await afterRestart.lookup('delivery-1')).toEqual(sent)
    expect(await afterRestart.send(boundRequest(afterRestart, 'delivery-1', '安全提醒'))).toEqual(sent)
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('marks an accepted response without a provider identity as explicitly unverifiable', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValueOnce({ data: { ret: 0 } })
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('default')
    expect(await sender.send(boundRequest(sender, 'delivery-unverified', '提醒')))
      .toEqual({ status: 'unknown', providerMessageId: null })
    expect(await sender.lookup('delivery-unverified')).toEqual({ status: 'unknown', providerMessageId: null })
    const afterCrash = createWeixinReceiptSender('default')
    expect(await afterCrash.send(boundRequest(afterCrash, 'delivery-unverified', '提醒')))
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
    expect(await sender.send(boundRequest(sender, 'delivery-maybe-sent', '不应重发')))
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
    const first = left.send(boundRequest(left, 'delivery-atomic', '提醒'))
    const second = right.send(boundRequest(right, 'delivery-atomic', '提醒'))
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
    expect(await sender.send(boundRequest(sender, 'delivery-unsafe-id', '提醒')))
      .toEqual({ status: 'unknown', providerMessageId: null })
  })

  it('retries only a provider response that definitively proves not sent', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValueOnce({ data: { ret: -1, errmsg: 'rejected' } })
      .mockResolvedValueOnce({ data: { ret: 0, msgid: 'provider-after-retry' } })
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('default')
    const request = boundRequest(sender, 'delivery-rejected', '提醒')

    expect(await sender.send(request)).toEqual({ status: 'not_sent', providerMessageId: null })
    expect(await sender.send(request)).toEqual({ status: 'accepted', providerMessageId: 'provider-after-retry' })
    expect(mockPost).toHaveBeenCalledTimes(2)
    expect(sender.diagnostics?.().claimCount).toBe(1)
  })

  it('rejects an identity change after lookup before network and accepts the unchanged bound identity', async () => {
    const envPath = join(hermesHome, '.env')
    writeFileSync(envPath, [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValue({ data: { ret: 0, msgid: 'provider-bound' } })
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('default')
    const captured = sender.identity?.()
    expect(captured).not.toBeNull()
    expect(await sender.lookup('identity-bound')).toEqual({ status: 'not_found', providerMessageId: null })
    writeFileSync(envPath, [
      'WEIXIN_ACCOUNT_ID=acct-2', 'WEIXIN_TOKEN=token-2', 'WEIXIN_HOME_CHANNEL=wxid_user_2', '',
    ].join('\n'), 'utf-8')

    expect(await sender.send({ deliveryId: 'identity-bound', recipient: 'configured-self', message: '提醒',
      expectedAccountFingerprint: captured!.accountFingerprint }))
      .toEqual({ status: 'identity_mismatch', providerMessageId: null })
    expect(mockPost).not.toHaveBeenCalled()

    const current = sender.identity?.()
    expect(await sender.send({ deliveryId: 'identity-current', recipient: 'configured-self', message: '提醒',
      expectedAccountFingerprint: current!.accountFingerprint }))
      .toEqual({ status: 'accepted', providerMessageId: 'provider-bound' })
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockPost.mock.calls[0][2].headers.Authorization).toBe('Bearer token-2')
    expect(readFileSync(join(hermesHome, 'weixin-deliveries.sqlite'), 'latin1')).not.toContain('token-2')
  })

  it('allows exactly one concurrent transport for a durable not-sent retry', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-1', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    mockPost.mockResolvedValueOnce({ data: { ret: -1, errmsg: 'rejected' } })
    const { createWeixinReceiptSender } = await loadSender()
    const seed = createWeixinReceiptSender('default')
    const expectedAccountFingerprint = seed.identity?.()!.accountFingerprint
    const request = { deliveryId: 'delivery-concurrent-retry', recipient: 'configured-self' as const,
      message: '提醒', expectedAccountFingerprint }
    expect(await seed.send(request)).toEqual({ status: 'not_sent', providerMessageId: null })

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mockPost.mockImplementationOnce(async () => { await gate; return { data: { ret: 0, msgid: 'provider-one-retry' } } })
    const left = createWeixinReceiptSender('default')
    const right = createWeixinReceiptSender('default')
    const pending = [left.send(request), right.send(request)]
    await vi.waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2))
    release()
    await Promise.all(pending)

    expect(await seed.lookup(request.deliveryId)).toEqual({ status: 'accepted', providerMessageId: 'provider-one-retry' })
    expect(await seed.send(request)).toEqual({ status: 'accepted', providerMessageId: 'provider-one-retry' })
    expect(mockPost).toHaveBeenCalledTimes(2)
  })

  it('keeps durable dedupe identities beyond the former page cap and reports capacity', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=acct-1', 'WEIXIN_TOKEN=token-never-persisted', 'WEIXIN_HOME_CHANNEL=wxid_user_1', '',
    ].join('\n'), 'utf-8')
    const { createWeixinReceiptSender } = await loadSender()
    const sender = createWeixinReceiptSender('default')
    expect(await sender.lookup('capacity-seed')).toEqual({ status: 'not_found', providerMessageId: null })
    const db = new DatabaseSync(join(hermesHome, 'weixin-deliveries.sqlite'))
    db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
      INSERT INTO weixin_delivery_claims(delivery_id,material_digest,status,provider_message_id,claimed_at,updated_at)
      SELECT 'capacity-'||i, lower(hex(randomblob(32))), 'unknown', NULL,
        '2026-07-14T00:00:00Z','2026-07-14T00:00:00Z' FROM n;`)
    db.close()

    expect(sender.diagnostics?.().claimCount).toBe(20_000)
    expect(await sender.lookup('capacity-20000')).toEqual({ status: 'unknown', providerMessageId: null })
    expect(mockPost).not.toHaveBeenCalled()
  })
})
