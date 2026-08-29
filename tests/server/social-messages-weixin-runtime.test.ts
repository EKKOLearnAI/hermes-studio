import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIlinkPost } = vi.hoisted(() => ({
  mockIlinkPost: vi.fn(),
}))
const { notifyBinding } = vi.hoisted(() => ({ notifyBinding: vi.fn() }))
const database = vi.hoisted(() => ({ value: null as any }))

vi.mock('../../packages/server/src/modules/studio/services/social-messages/weixin-ilink', () => ({
  weixinIlinkPost: mockIlinkPost,
}))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => database.value }))
vi.mock('../../packages/server/src/modules/studio/services/social-messages/binding-notification', () => ({
  notifyFirstSocialMessageBinding: notifyBinding,
}))

describe('standalone Weixin runtime', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    notifyBinding.mockResolvedValue(true)
    const { DatabaseSync } = await import('node:sqlite')
    database.value = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(async () => {
    const runtime = await import('../../packages/server/src/modules/studio/services/social-messages/weixin-runtime')
    await runtime.shutdownSocialMessageRuntimes()
    database.value?.close()
    database.value = null
    vi.resetModules()
  })

  it('polls independently and persists this Bot’s peer context token', async () => {
    mockIlinkPost
      .mockResolvedValueOnce({
        ret: 0,
        get_updates_buf: 'next-sync',
        msgs: [{
          from_user_id: 'peer-1',
          context_token: 'peer-context',
          item_list: [{ type: 1, text_item: { text: 'hello' } }],
        }],
      })
      .mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))

    const runtime = await import('../../packages/server/src/modules/studio/services/social-messages/weixin-runtime')
    const credentials = {
      accountId: 'standalone-bot@im.bot',
      token: 'standalone-token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    }
    runtime.ensureWeixinRuntime(7, credentials)

    await vi.waitFor(() => expect(mockIlinkPost).toHaveBeenCalledTimes(2))
    expect(notifyBinding).toHaveBeenCalledWith({
      userId: 7,
      platform: 'weixin',
      recipient: 'peer-1',
      recipientType: 'user_id',
      contextToken: 'peer-context',
    })
    const result = await runtime.listWeixinRecipients(7, credentials)

    expect(result.recipients).toEqual([expect.objectContaining({
      userId: 'peer-1',
      hasContextToken: true,
    })])
    await expect(runtime.resolveWeixinContextToken(7, credentials, 'peer-1')).resolves.toBe('peer-context')
    expect(mockIlinkPost.mock.calls[0][0]).toMatchObject({
      endpoint: 'ilink/bot/getupdates',
      token: 'standalone-token',
      payload: { get_updates_buf: '' },
    })
  })

  it('clears stale recipients and retries without the old sync buffer after session timeout', async () => {
    const pendingUntilAbort = ({ signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    mockIlinkPost
      .mockResolvedValueOnce({
        ret: 0,
        get_updates_buf: 'stale-sync',
        msgs: [{ from_user_id: 'stale-peer', context_token: 'stale-context' }],
      })
      .mockImplementation(pendingUntilAbort)

    const runtime = await import('../../packages/server/src/modules/studio/services/social-messages/weixin-runtime')
    const credentials = {
      accountId: 'standalone-bot@im.bot',
      token: 'replacement-token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    }
    runtime.ensureWeixinRuntime(7, credentials)
    await vi.waitFor(() => expect(mockIlinkPost).toHaveBeenCalledTimes(2))
    await runtime.stopWeixinRuntime(7)

    mockIlinkPost.mockReset()
    mockIlinkPost
      .mockResolvedValueOnce({ ret: 0, errcode: -14, errmsg: 'session timeout' })
      .mockResolvedValueOnce({ ret: 0, get_updates_buf: 'fresh-sync', msgs: [] })
      .mockImplementation(pendingUntilAbort)

    runtime.ensureWeixinRuntime(7, credentials)
    await vi.waitFor(() => expect(mockIlinkPost).toHaveBeenCalledTimes(3))

    expect(mockIlinkPost.mock.calls[0][0].payload).toEqual({ get_updates_buf: 'stale-sync' })
    expect(mockIlinkPost.mock.calls[1][0].payload).toEqual({ get_updates_buf: '' })
    await expect(runtime.listWeixinRecipients(7, credentials)).resolves.toMatchObject({
      recipients: [],
      runtimeStatus: 'running',
    })
  })
})
