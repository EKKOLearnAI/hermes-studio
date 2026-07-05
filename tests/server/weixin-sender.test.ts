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
})
