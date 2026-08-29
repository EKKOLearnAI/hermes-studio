import { describe, expect, it, vi } from 'vitest'
import {
  beginFeishuQrRegistration,
  pollFeishuQrRegistration,
} from '../../packages/server/src/modules/studio/services/social-messages/feishu-onboarding'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Feishu QR app registration', () => {
  it('uses the Hermes Agent registration protocol and returns a QR session', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ supported_auth_methods: ['client_secret'] }))
      .mockResolvedValueOnce(jsonResponse({
        device_code: 'device-code',
        verification_uri_complete: 'https://accounts.feishu.cn/device?code=user-code',
        user_code: 'user-code',
        interval: 3,
        expire_in: 420,
      }))

    const result = await beginFeishuQrRegistration(fetcher as typeof fetch)

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'https://accounts.feishu.cn/oauth/v1/app/registration',
      'https://accounts.feishu.cn/oauth/v1/app/registration',
    ])
    expect(Object.fromEntries(new URLSearchParams(fetcher.mock.calls[0][1].body))).toEqual({ action: 'init' })
    expect(Object.fromEntries(new URLSearchParams(fetcher.mock.calls[1][1].body))).toEqual({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    })
    expect(result).toEqual({
      deviceCode: 'device-code',
      qrUrl: 'https://accounts.feishu.cn/device?code=user-code&from=hermes&tp=hermes',
      userCode: 'user-code',
      pollIntervalMs: 3_000,
      expiresInMs: 420_000,
    })
  })

  it('treats the documented HTTP 400 authorization_pending response as pending', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      error: 'authorization_pending',
    }, 400))

    await expect(pollFeishuQrRegistration('device-code', fetcher as typeof fetch))
      .resolves.toEqual({ status: 'pending' })
    expect(Object.fromEntries(new URLSearchParams(fetcher.mock.calls[0][1].body))).toEqual({
      action: 'poll',
      device_code: 'device-code',
      tp: 'ob_app',
    })
  })

  it('returns created credentials only from the server-side poll result', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      client_id: 'cli_scanned',
      client_secret: 'server-only-secret',
      user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' },
    }))

    await expect(pollFeishuQrRegistration('device-code', fetcher as typeof fetch)).resolves.toEqual({
      status: 'confirmed',
      appId: 'cli_scanned',
      appSecret: 'server-only-secret',
      openId: 'ou_owner',
    })
  })
})
