// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAppAuthConfig,
  registerAppAccount,
  sendAppRegistrationCode,
} from '@/api/hermes/app-auth'

const session = {
  ok: true,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresIn: '15m',
  user: {
    id: 9,
    email: 'app@example.com',
    displayName: 'App User',
    avatarUrl: '',
    emailVerified: true,
  },
}

function response(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  }
}

describe('APP account API', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('registers with the email verification code and stores a URL-scoped session', async () => {
    vi.mocked(fetch).mockResolvedValue(response(session) as Response)

    await registerAppAccount('http://127.0.0.1:8077/', {
      email: 'app@example.com',
      password: 'password123',
      verificationCode: '123456',
    })

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8077/api/app/auth/register', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        email: 'app@example.com',
        password: 'password123',
        verificationCode: '123456',
      }),
    }))
    expect(localStorage.getItem('hermes.appRelay.authSession')).toContain('http://127.0.0.1:8077')
  })

  it('requests email codes only from the central server', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: true, expiresIn: 600, retryAfter: 60 }) as Response)

    await expect(sendAppRegistrationCode('https://api.hermes-studio.ai', 'app@example.com'))
      .resolves.toEqual({ expiresIn: 600, retryAfter: 60 })

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.hermes-studio.ai/api/app/auth/email-code', expect.anything())
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('loads the public email-delivery availability config', async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      ok: true,
      emailVerificationEnabled: true,
    }) as Response)

    await expect(fetchAppAuthConfig('https://api.hermes-studio.ai')).resolves.toEqual({
      emailVerificationEnabled: true,
    })
  })
})
