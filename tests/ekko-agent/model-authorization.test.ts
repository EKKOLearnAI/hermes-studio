import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EkkoModelAuthorizationError,
  refreshStandardOAuthToken,
  setupEkkoAgent,
} from '../../packages/ekko-agent/src'

let baseDirectory = ''

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'ekko-authorization-'))
})

afterEach(async () => {
  await rm(baseDirectory, { recursive: true, force: true })
})

describe('Ekko model authorization', () => {
  it('refreshes an expiring authorized provider before the request and persists rotated credentials', async () => {
    const now = Date.parse('2026-08-20T08:00:00Z')
    const refresher = vi.fn(async () => ({
      accessToken: 'fresh-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 3600,
      baseUrl: 'https://api.x.ai/v1',
      apiMode: 'codex_responses' as const,
    }))
    const setup = setupEkkoAgent({
      baseDirectory,
      env: { NODE_ENV: 'test' },
      authorizationRefresher: refresher,
      authorizationNow: () => now,
    })
    try {
      setup.config.installModelProviderPreset('xai-oauth', { defaultModel: 'grok-4.5' })
      setup.authorizations.set('xai-oauth', {
        type: 'oauth',
        accessToken: 'stale-access-token',
        refreshToken: 'old-refresh-token',
        expiresAt: '2026-08-20T08:01:00Z',
      })
      const fetch = vi.fn(async () => new Response(JSON.stringify({
        output_text: 'refreshed',
        status: 'completed',
      })))
      const client = setup.createModelClient({ provider: 'xai-oauth' }, { fetch })

      await expect(client.create({ messages: [{ role: 'user', content: 'hello' }] }))
        .resolves.toMatchObject({ content: 'refreshed' })
      await expect(client.create({ messages: [{ role: 'user', content: 'again' }] }))
        .resolves.toMatchObject({ content: 'refreshed' })

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(refresher).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'xai-oauth',
        model: undefined,
        authorization: expect.objectContaining({ refreshToken: 'old-refresh-token' }),
        providerSettings: expect.objectContaining({ apiMode: 'codex_responses' }),
      }))
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch.mock.calls[0]?.[0]).toBe('https://api.x.ai/v1/responses')
      expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
        authorization: 'Bearer fresh-access-token',
      })
      expect(setup.authorizations.get('xai-oauth')).toMatchObject({
        accessToken: 'fresh-access-token',
        refreshToken: 'rotated-refresh-token',
        obtainedAt: '2026-08-20T08:00:00.000Z',
        expiresAt: '2026-08-20T09:00:00.000Z',
        apiMode: 'codex_responses',
      })
    } finally {
      setup.close()
    }
  })

  it('deduplicates concurrent refreshes for one provider', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const refresher = vi.fn(async () => {
      await pending
      return { accessToken: 'shared-token', expiresIn: 3600 }
    })
    const setup = setupEkkoAgent({
      baseDirectory,
      env: { NODE_ENV: 'test' },
      authorizationRefresher: refresher,
      authorizationNow: () => Date.parse('2026-08-20T08:00:00Z'),
    })
    try {
      setup.config.installModelProviderPreset('openai-codex')
      setup.authorizations.set('openai-codex', {
        type: 'oauth',
        refreshToken: 'refresh-token',
      })

      const first = setup.authorizations.resolve('openai-codex')
      const second = setup.authorizations.resolve('openai-codex')
      release()

      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ accessToken: 'shared-token' }),
        expect.objectContaining({ accessToken: 'shared-token' }),
      ])
      expect(refresher).toHaveBeenCalledTimes(1)
    } finally {
      setup.close()
    }
  })

  it('fails closed instead of using an expiring stale token when refresh fails', async () => {
    const setup = setupEkkoAgent({
      baseDirectory,
      env: { NODE_ENV: 'test' },
      authorizationRefresher: async () => {
        throw new Error('re-login required')
      },
      authorizationNow: () => Date.parse('2026-08-20T08:00:00Z'),
    })
    try {
      setup.config.installModelProviderPreset('minimax-oauth')
      setup.authorizations.set('minimax-oauth', {
        type: 'oauth',
        accessToken: 'stale-token',
        refreshToken: 'invalid-refresh-token',
        expiresAt: '2026-08-20T08:00:30Z',
      })

      await expect(setup.authorizations.resolve('minimax-oauth')).rejects.toMatchObject({
        message: expect.stringContaining('re-login required'),
        provider: 'minimax-oauth',
        code: 'MODEL_AUTHORIZATION_REFRESH_FAILED',
      })
      expect(setup.authorizations.get('minimax-oauth')?.accessToken).toBe('stale-token')
    } finally {
      setup.close()
    }
  })

  it('supports standard refresh-token grants without a host refresher', async () => {
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => new Response(JSON.stringify({
      access_token: 'standard-access-token',
      refresh_token: 'standard-rotated-token',
      expires_in: 1800,
    }), { status: 200 }))

    await expect(refreshStandardOAuthToken('custom-oauth', {
      type: 'oauth',
      refreshToken: 'standard-refresh-token',
      tokenUrl: 'https://auth.example.test/oauth/token',
      clientId: 'client-id',
      scope: 'openid offline_access',
      tokenParams: { audience: 'models' },
    }, fetch)).resolves.toEqual({
      accessToken: 'standard-access-token',
      refreshToken: 'standard-rotated-token',
      expiresIn: 1800,
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://auth.example.test/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = fetch.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(Object.fromEntries(body.entries())).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'standard-refresh-token',
      client_id: 'client-id',
      scope: 'openid offline_access',
      audience: 'models',
    })
  })

  it('marks missing refresh material as requiring login', async () => {
    const promise = refreshStandardOAuthToken('openai-codex', {
      type: 'oauth',
      accessToken: 'expired-token',
    })
    await expect(promise).rejects.toBeInstanceOf(EkkoModelAuthorizationError)
    await expect(promise).rejects.toMatchObject({
      code: 'MODEL_AUTHORIZATION_REFRESH_UNAVAILABLE',
      reloginRequired: true,
    })
  })
})
