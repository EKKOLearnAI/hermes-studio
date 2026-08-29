import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuSocialMessageAdapter } from '../../packages/server/src/modules/studio/services/social-messages/adapters/feishu'
import { TelegramSocialMessageAdapter } from '../../packages/server/src/modules/studio/services/social-messages/adapters/telegram'
import { WeixinSocialMessageAdapter } from '../../packages/server/src/modules/studio/services/social-messages/adapters/weixin'
import { SocialMessageService } from '../../packages/server/src/modules/studio/services/social-messages/service'
import type { SocialMessageAdapter, SocialMessageSendInput } from '../../packages/server/src/modules/studio/services/social-messages/types'

const { feishuCreate, FeishuClient } = vi.hoisted(() => {
  const create = vi.fn()
  return {
    feishuCreate: create,
    FeishuClient: vi.fn(function (this: any) {
      this.im = { v1: { message: { create } } }
    }),
  }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: FeishuClient,
  AppType: { SelfBuild: 'self-build' },
  Domain: { Feishu: 'feishu' },
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const baseInput: SocialMessageSendInput = {
  platform: 'telegram',
  recipient: '1234',
  recipientType: 'chat_id',
  content: 'hello',
}

describe('social message platform adapters', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the official Telegram Bot API directly', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      result: { message_id: 42 },
    }))
    const adapter = new TelegramSocialMessageAdapter(fetcher)

    const result = await adapter.send(baseInput, { TELEGRAM_BOT_TOKEN: '123:abc_DEF' })

    expect(result.messageId).toBe('42')
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123:abc_DEF/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ chat_id: '1234', text: 'hello' })
  })

  it('uses the official Feishu SDK with the selected recipient type', async () => {
    feishuCreate.mockResolvedValue({ code: 0, data: { message_id: 'om_123' } })
    const adapter = new FeishuSocialMessageAdapter()

    const result = await adapter.send({
      ...baseInput,
      platform: 'feishu',
      recipient: 'ou_123',
      recipientType: 'open_id',
    }, {
      FEISHU_APP_ID: 'cli_123',
      FEISHU_APP_SECRET: 'secret',
    })

    expect(FeishuClient).toHaveBeenCalledWith(expect.objectContaining({ appId: 'cli_123', appSecret: 'secret' }))
    expect(feishuCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    })
    expect(result.messageId).toBe('om_123')
  })

  it('calls the official Weixin iLink endpoint and retries tokenless after an expired context', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ret: -14, errmsg: 'expired' }))
      .mockResolvedValueOnce(jsonResponse({ ret: 0 }))
    const adapter = new WeixinSocialMessageAdapter(fetcher)

    const result = await adapter.send({
      ...baseInput,
      platform: 'weixin',
      recipient: 'wx-user',
      recipientType: 'user_id',
      contextToken: 'peer-context',
    }, {
      WEIXIN_ACCOUNT_ID: 'bot-account',
      WEIXIN_TOKEN: 'bot-token',
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage')
    const firstBody = JSON.parse(fetcher.mock.calls[0][1].body)
    const secondBody = JSON.parse(fetcher.mock.calls[1][1].body)
    expect(firstBody.msg.context_token).toBe('peer-context')
    expect(secondBody.msg.context_token).toBeUndefined()
    expect(result.messageId).toMatch(/^studio-weixin-/)
  })
})

describe('SocialMessageService', () => {
  const send = vi.fn()
  const adapter: SocialMessageAdapter = {
    platform: 'telegram',
    recipientTypes: ['chat_id'],
    defaultRecipientType: 'chat_id',
    maxContentLength: 10,
    supportsContextToken: false,
    isConfigured: credentials => credentials.ready === 'yes',
    send,
  }
  const credentials = vi.fn().mockResolvedValue({ ready: 'yes' })

  beforeEach(() => {
    vi.clearAllMocks()
    credentials.mockResolvedValue({ ready: 'yes' })
    send.mockResolvedValue({
      platform: 'telegram', recipient: 'room', messageId: '1', sentAt: '2026-08-23T00:00:00.000Z',
    })
  })

  it('exposes configured adapters and sends through the unified contract', async () => {
    const service = new SocialMessageService(
      [adapter],
      credentials,
      async () => undefined,
      async () => 'telegram',
      async () => 'fr',
      async () => true,
    )

    await expect(service.listPlatforms(7)).resolves.toEqual([expect.objectContaining({
      id: 'telegram', configured: true, active: true, notificationLocale: 'fr', pushReady: true,
      defaultRecipientType: 'chat_id',
    })])
    await service.send(7, { platform: 'telegram', recipient: ' room ', content: ' hello ' })

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'telegram', recipient: 'room', recipientType: 'chat_id', content: 'hello',
    }), { ready: 'yes' })
  })

  it('rejects oversized content before any platform call', async () => {
    const service = new SocialMessageService([adapter], credentials)

    await expect(service.send(7, {
      platform: 'telegram', recipient: 'room', content: '12345678901',
    })).rejects.toMatchObject({ code: 'invalid_request', status: 400 })
    expect(send).not.toHaveBeenCalled()
  })

  it('fails closed when the authenticated user has no platform credentials', async () => {
    credentials.mockResolvedValueOnce({})
    const service = new SocialMessageService([adapter], credentials)

    await expect(service.send(7, {
      platform: 'telegram', recipient: 'room', content: 'hello',
    })).rejects.toMatchObject({ code: 'platform_not_configured', status: 409 })
    expect(send).not.toHaveBeenCalled()
  })
})
