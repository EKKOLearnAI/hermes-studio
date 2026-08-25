import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: unknown) => Promise<void>>,
  start: vi.fn(),
  close: vi.fn(),
}))
const { notifyBinding } = vi.hoisted(() => ({ notifyBinding: vi.fn() }))
const database = vi.hoisted(() => ({ value: null as any }))

vi.mock('../../packages/server/src/db/index', () => ({ getDb: () => database.value }))
vi.mock('../../packages/server/src/services/social-messages/binding-notification', () => ({
  notifyFirstSocialMessageBinding: notifyBinding,
}))

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu' },
  EventDispatcher: class {
    register(handlers: Record<string, (event: unknown) => Promise<void>>) {
      Object.assign(sdk.handlers, handlers)
      return this
    }
  },
  WSClient: class {
    start = sdk.start
    close = sdk.close
  },
}))

describe('standalone Feishu runtime', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    sdk.handlers = {}
    sdk.start.mockResolvedValue(undefined)
    notifyBinding.mockResolvedValue(true)
    const { DatabaseSync } = await import('node:sqlite')
    database.value = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(async () => {
    const runtime = await import('../../packages/server/src/services/social-messages/feishu-runtime')
    runtime.shutdownFeishuRuntimes()
    database.value?.close()
    database.value = null
    vi.resetModules()
  })

  it('records an inbound chat as the automatic push target and persists it', async () => {
    const runtime = await import('../../packages/server/src/services/social-messages/feishu-runtime')
    const credentials = {
      appId: 'cli_1234567890abcdef',
      appSecret: 'standalone-secret',
    }

    runtime.ensureFeishuRuntime(7, credentials)
    expect(sdk.start).toHaveBeenCalledTimes(1)
    await sdk.handlers['im.message.receive_v1']({
      sender: { sender_type: 'user' },
      message: { chat_id: 'oc_target', chat_type: 'p2p' },
    })
    expect(notifyBinding).toHaveBeenCalledWith({
      userId: 7,
      platform: 'feishu',
      recipient: 'oc_target',
      recipientType: 'chat_id',
    })

    await expect(runtime.listFeishuRecipients(7, credentials)).resolves.toEqual({
      recipients: [expect.objectContaining({ chatId: 'oc_target', chatType: 'p2p' })],
      runtimeStatus: 'running',
    })
    expect(sdk.start).toHaveBeenCalledTimes(1)

    runtime.stopFeishuRuntime(7)
    runtime.ensureFeishuRuntime(7, credentials)
    await expect(runtime.listFeishuRecipients(7, credentials)).resolves.toMatchObject({
      recipients: [expect.objectContaining({ chatId: 'oc_target' })],
    })
  })

  it('ignores app-authored events and clears targets when reset', async () => {
    const runtime = await import('../../packages/server/src/services/social-messages/feishu-runtime')
    const credentials = {
      appId: 'cli_fedcba0987654321',
      appSecret: 'standalone-secret',
    }
    runtime.ensureFeishuRuntime(7, credentials)

    await sdk.handlers['im.message.receive_v1']({
      sender: { sender_type: 'app' },
      message: { chat_id: 'oc_bot', chat_type: 'group' },
    })
    expect(notifyBinding).not.toHaveBeenCalled()
    await expect(runtime.listFeishuRecipients(7, credentials)).resolves.toMatchObject({ recipients: [] })

    await sdk.handlers['im.message.receive_v1']({
      sender: { sender_type: 'user' },
      message: { chat_id: 'oc_user', chat_type: 'group' },
    })
    await runtime.resetFeishuRuntimeState(7, credentials.appId)
    await expect(runtime.listFeishuRecipients(7, credentials)).resolves.toMatchObject({ recipients: [] })
  })
})
