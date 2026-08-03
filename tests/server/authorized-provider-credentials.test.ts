import { describe, expect, it, vi } from 'vitest'
import {
  AuthorizedProviderCredentialError,
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
} from '../../packages/server/src/services/hermes/authorized-provider-credentials'

describe('authorized provider runtime credentials', () => {
  it('maps the profile-scoped Bridge response without persisting credentials in Studio', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      resolved: true,
      requested_provider: 'xai-oauth',
      provider: 'xai-oauth',
      api_key: 'fresh-grok-token',
      base_url: 'https://api.x.ai/v1/',
      api_mode: 'codex_responses',
      source: 'hermes-auth-store',
      last_refresh: '2026-08-03T09:00:00Z',
    })

    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'research',
      provider: 'xai-oauth',
      model: 'grok-4.3',
    }, { request })).resolves.toEqual({
      provider: 'xai-oauth',
      apiKey: 'fresh-grok-token',
      baseUrl: 'https://api.x.ai/v1',
      apiMode: 'codex_responses',
      source: 'hermes-auth-store',
      lastRefresh: '2026-08-03T09:00:00Z',
    })
    expect(request).toHaveBeenCalledWith('research', 'xai-oauth', 'grok-4.3')
  })

  it('preserves Hermes Agent re-login metadata', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      resolved: false,
      requested_provider: 'minimax-oauth',
      error: 'refresh token is invalid',
      code: 'refresh_failed',
      relogin_required: true,
    })

    const promise = resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'minimax-oauth',
    }, { request })
    await expect(promise).rejects.toMatchObject({
      message: 'refresh token is invalid',
      provider: 'minimax-oauth',
      code: 'refresh_failed',
      reloginRequired: true,
    })
  })

  it('rejects providers outside the Hermes authorization store before Bridge access', async () => {
    const request = vi.fn()
    expect(isAuthorizedRuntimeProvider('deepseek')).toBe(false)
    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'deepseek',
    }, { request })).rejects.toBeInstanceOf(AuthorizedProviderCredentialError)
    expect(request).not.toHaveBeenCalled()
  })
})
