import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))
const { notifyBinding } = vi.hoisted(() => ({ notifyBinding: vi.fn() }))
const database = vi.hoisted(() => ({ value: null as any }))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => database.value }))
vi.mock('../../packages/server/src/modules/studio/services/social-messages/binding-notification', () => ({
  notifyFirstSocialMessageBinding: notifyBinding,
}))

function telegramResponse(payload: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

function pendingUntilAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe('standalone Telegram runtime', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    notifyBinding.mockResolvedValue(true)
    vi.stubGlobal('fetch', mockFetch)
    const { DatabaseSync } = await import('node:sqlite')
    database.value = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(async () => {
    const runtime = await import('../../packages/server/src/modules/studio/services/social-messages/telegram-runtime')
    await runtime.shutdownTelegramRuntimes()
    database.value?.close()
    database.value = null
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('long-polls inbound updates, persists chats, and resumes from the saved offset', async () => {
    mockFetch
      .mockResolvedValueOnce(telegramResponse({
        ok: true,
        result: [
          {
            update_id: 40,
            message: {
              from: { is_bot: false },
              chat: { id: 1234, type: 'private', username: 'alice', first_name: 'Alice' },
            },
          },
          {
            update_id: 41,
            channel_post: { chat: { id: -10099, type: 'channel', title: 'Release notes' } },
          },
        ],
      }))
      .mockImplementation((_url, init: RequestInit) => pendingUntilAbort(init.signal as AbortSignal))

    const runtime = await import('../../packages/server/src/modules/studio/services/social-messages/telegram-runtime')
    const credentials = { botToken: '123456:standalone_token' }
    runtime.ensureTelegramRuntime(7, credentials)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(notifyBinding).toHaveBeenCalledWith({
      userId: 7,
      platform: 'telegram',
      recipient: '1234',
      recipientType: 'chat_id',
    })
    await expect(runtime.listTelegramRecipients(7, credentials)).resolves.toMatchObject({
      recipients: expect.arrayContaining([
        expect.objectContaining({ chatId: '1234', chatType: 'private', username: 'alice' }),
        expect.objectContaining({ chatId: '-10099', chatType: 'channel', title: 'Release notes' }),
      ]),
      runtimeStatus: 'running',
    })
    expect(JSON.parse(String(mockFetch.mock.calls[0][1].body))).toEqual({
      offset: 0,
      timeout: 30,
      allowed_updates: ['message', 'channel_post'],
    })

    await runtime.stopTelegramRuntime(7)
    mockFetch.mockReset()
    mockFetch.mockImplementation((_url, init: RequestInit) => pendingUntilAbort(init.signal as AbortSignal))
    runtime.ensureTelegramRuntime(7, credentials)
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(mockFetch.mock.calls[0][1].body))).toMatchObject({ offset: 42 })
  })
})
