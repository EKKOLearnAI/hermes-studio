import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isAuthorizedRuntimeProvider: vi.fn(),
  resolveCredentials: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/authorized-provider-runtime', () => ({
  isAuthorizedRuntimeProvider: mocks.isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials: mocks.resolveCredentials,
}))

describe('Ekko Agent authorized provider credentials', () => {
  beforeEach(() => {
    mocks.isAuthorizedRuntimeProvider.mockReset()
    mocks.resolveCredentials.mockReset()
    mocks.isAuthorizedRuntimeProvider.mockImplementation((provider: string) => (
      ['nous', 'openai-codex', 'xai-oauth', 'qwen-oauth', 'claude-oauth', 'minimax-oauth']
        .includes(provider)
    ))
  })

  it('uses fresh Hermes Agent runtime credentials without exposing refresh tokens', async () => {
    mocks.resolveCredentials.mockResolvedValue({
      provider: 'minimax-oauth',
      apiKey: 'fresh-access-token',
      baseUrl: 'https://api.minimax.io/anthropic',
      apiMode: 'anthropic_messages',
      source: 'oauth',
    })
    const { resolveEkkoAuthorizedProviderCredentials } = await import(
      '../../packages/server/src/modules/ekko/services/auth-providers'
    )

    await expect(resolveEkkoAuthorizedProviderCredentials(
      'research',
      'minimax-oauth',
      'MiniMax-M3',
    )).resolves.toEqual({
      apiKey: 'fresh-access-token',
      baseUrl: 'https://api.minimax.io/anthropic',
      apiMode: 'anthropic_messages',
    })
    expect(mocks.resolveCredentials).toHaveBeenCalledWith({
      profile: 'research',
      provider: 'minimax-oauth',
      model: 'MiniMax-M3',
    })
  })

  it('ignores non-auth providers', async () => {
    const { resolveEkkoAuthorizedProviderCredentials } = await import(
      '../../packages/server/src/modules/ekko/services/auth-providers'
    )

    await expect(resolveEkkoAuthorizedProviderCredentials('work', 'deepseek')).resolves.toEqual({})
    expect(mocks.resolveCredentials).not.toHaveBeenCalled()
  })

  it('propagates refresh failures instead of falling back to a stale token', async () => {
    mocks.resolveCredentials.mockRejectedValue(new Error('re-login required'))
    const { resolveEkkoAuthorizedProviderCredentials } = await import(
      '../../packages/server/src/modules/ekko/services/auth-providers'
    )

    await expect(resolveEkkoAuthorizedProviderCredentials('default', 'xai-oauth'))
      .rejects.toThrow('re-login required')
  })
})
