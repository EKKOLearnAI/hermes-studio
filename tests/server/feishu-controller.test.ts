import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { beginRegistration, pollRegistration } = vi.hoisted(() => ({
  beginRegistration: vi.fn(),
  pollRegistration: vi.fn(),
}))

vi.mock('../../packages/server/src/services/social-messages/feishu-onboarding', () => ({
  beginFeishuQrRegistration: beginRegistration,
  pollFeishuQrRegistration: pollRegistration,
}))

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const database = vi.hoisted(() => ({ value: null as any }))
let studioHome = ''

vi.mock('../../packages/server/src/db/index', () => ({ getDb: () => database.value }))

function makeCtx(userId = 7, profile = 'research', query: Record<string, string> = {}): any {
  return {
    query,
    request: { body: {} },
    state: { user: { id: userId }, profile: { name: profile } },
    status: 200,
    body: undefined,
  }
}

describe('social messages Feishu QR registration', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const { DatabaseSync } = await import('node:sqlite')
    database.value = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    studioHome = await mkdtemp(join(tmpdir(), 'studio-feishu-controller-'))
    process.env.HERMES_WEB_UI_HOME = studioHome
    beginRegistration.mockResolvedValue({
      deviceCode: 'private-device-code',
      qrUrl: 'https://accounts.feishu.cn/device?code=visible',
      userCode: 'visible',
      pollIntervalMs: 2_000,
      expiresInMs: 600_000,
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    database.value?.close()
    database.value = null
    vi.resetModules()
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    if (studioHome) await rm(studioHome, { recursive: true, force: true })
    studioHome = ''
  })

  it('keeps app secrets on the server and saves them to the initiating user', async () => {
    pollRegistration.mockResolvedValue({
      status: 'confirmed',
      appId: 'cli_scanned',
      appSecret: 'server-only-secret',
      openId: 'ou_owner',
    })
    const { getFeishuQrcode, pollFeishuQrcodeStatus } = await import(
      '../../packages/server/src/controllers/social-messages'
    )
    const startCtx = makeCtx(7, 'research', { locale: 'zh-TW' })

    await getFeishuQrcode(startCtx)

    expect(startCtx.body).toEqual(expect.objectContaining({
      qrcode_url: 'https://accounts.feishu.cn/device?code=visible',
      poll_interval_ms: 2_000,
      expires_in_ms: 600_000,
    }))
    expect(startCtx.body).not.toHaveProperty('device_code')
    expect(startCtx.body).not.toHaveProperty('app_secret')

    vi.advanceTimersByTime(2_000)
    const pollCtx = makeCtx(7, 'default', { session: startCtx.body.session_id, locale: 'ja' })
    await pollFeishuQrcodeStatus(pollCtx)

    expect(pollRegistration).toHaveBeenCalledWith('private-device-code')
    expect(pollCtx.body).toEqual({ status: 'confirmed', open_id: 'ou_owner' })
    expect(JSON.stringify(pollCtx.body)).not.toContain('server-only-secret')
    const { readSocialMessageCredentials } = await import(
      '../../packages/server/src/services/social-messages/credentials'
    )
    await expect(readSocialMessageCredentials(7)).resolves.toMatchObject({
      FEISHU_APP_ID: 'cli_scanned',
      FEISHU_APP_SECRET: 'server-only-secret',
    })
    await expect(readSocialMessageCredentials(8)).resolves.toEqual({})
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    expect(store.getSocialMessageAccount(7, 'feishu')).toMatchObject({
      bindingLocale: 'ja',
      bindingNotified: false,
    })
  })

  it('does not allow another user to poll the registration session', async () => {
    const { getFeishuQrcode, pollFeishuQrcodeStatus } = await import(
      '../../packages/server/src/controllers/social-messages'
    )
    const startCtx = makeCtx(7, 'research')
    await getFeishuQrcode(startCtx)

    const pollCtx = makeCtx(8, 'research', { session: startCtx.body.session_id })
    await pollFeishuQrcodeStatus(pollCtx)

    expect(pollCtx.body).toEqual({ status: 'expired' })
    expect(pollRegistration).not.toHaveBeenCalled()
  })
})
