import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Social Messages SQLite store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({ getDb: () => db }))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  it('enforces one active account per user and keeps targets on their account row', async () => {
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    store.upsertSocialMessageAccount({
      userId: 7,
      platform: 'feishu',
      credentials: { appId: 'cli_1', appSecret: 'secret' },
      active: true,
    })
    store.upsertSocialMessageAccount({
      userId: 7,
      platform: 'weixin',
      credentials: { accountId: 'bot', token: 'token', baseUrl: 'https://weixin.example' },
      active: true,
      bindingLocale: 'zh',
    })
    store.setSocialMessageAccountTarget({
      userId: 7,
      platform: 'weixin',
      recipient: 'wx-user',
      recipientType: 'user_id',
      active: true,
    })

    expect(store.listSocialMessageAccounts(7).filter(account => account.active)).toHaveLength(1)
    expect(store.getActiveSocialMessageAccount(7)).toMatchObject({
      platform: 'weixin',
      recipient: 'wx-user',
      recipientType: 'user_id',
      bindingLocale: 'zh',
      bindingNotified: false,
    })
    expect(store.markSocialMessageBindingNotified(7, 'weixin')).toBe(true)
    expect(store.markSocialMessageBindingNotified(7, 'weixin')).toBe(false)
    expect(store.setSocialMessageAccountLocale(7, 'weixin', 'ja')).toBe(true)
    expect(store.getSocialMessageAccount(7, 'weixin')).toMatchObject({
      bindingLocale: 'ja',
      bindingNotified: true,
    })
    store.upsertSocialMessageAccount({
      userId: 7,
      platform: 'weixin',
      credentials: { accountId: 'bot', token: 'token', baseUrl: 'https://weixin.example' },
      active: true,
      bindingLocale: 'fr',
    })
    expect(store.getSocialMessageAccount(7, 'weixin')).toMatchObject({
      bindingLocale: 'fr',
      bindingNotified: true,
    })
    expect(() => db.prepare(
      `UPDATE social_message_accounts SET active = 1 WHERE user_id = 7`,
    ).run()).toThrow()

    store.writeSocialMessageRuntimeState(7, 'weixin', 'old-account', { syncBuf: 'old' })
    store.upsertSocialMessageAccount({
      userId: 7,
      platform: 'weixin',
      credentials: { accountId: 'replacement', token: 'replacement-token' },
      active: true,
    })
    expect(store.getActiveSocialMessageAccount(7)).toMatchObject({
      platform: 'weixin',
      recipient: '',
      recipientType: '',
      bindingNotified: false,
    })
    expect(store.readSocialMessageRuntimeState(7, 'weixin', 'old-account')).toBeNull()
  })

  it('stores runtime cursor and peer state in SQLite', async () => {
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    store.writeSocialMessageRuntimeState(7, 'weixin', 'account-key', {
      syncBuf: 'cursor',
      peers: { 'wx-user': { contextToken: 'context' } },
    })

    expect(store.readSocialMessageRuntimeState(7, 'weixin', 'account-key')).toEqual({
      syncBuf: 'cursor',
      peers: { 'wx-user': { contextToken: 'context' } },
    })
    expect(store.readSocialMessageRuntimeState(7, 'weixin', 'different-key')).toBeNull()
    expect(store.deleteSocialMessageRuntimeState(7, 'weixin', 'account-key')).toBe(true)
  })
})
