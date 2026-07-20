import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readConfigYamlForProfile: vi.fn(),
  safeReadFile: vi.fn(),
  resolveAuthorized: vi.fn(),
}))

vi.mock('../../packages/server/src/services/config-helpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../packages/server/src/services/config-helpers')>(),
  readConfigYamlForProfile: mocks.readConfigYamlForProfile,
  safeReadFile: mocks.safeReadFile,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => `/profiles/${profile}`,
}))

vi.mock('../../packages/server/src/services/ekko-agent/auth-providers', () => ({
  resolveEkkoAuthorizedProviderCredentials: mocks.resolveAuthorized,
}))

describe('resolveEkkoProviderRuntimeConfig', () => {
  beforeEach(() => {
    mocks.readConfigYamlForProfile.mockReset()
    mocks.safeReadFile.mockReset()
    mocks.resolveAuthorized.mockReset()
    mocks.readConfigYamlForProfile.mockResolvedValue({})
    mocks.safeReadFile.mockResolvedValue('')
    mocks.resolveAuthorized.mockResolvedValue({})
  })

  it('resolves a built-in provider from the profile env and preset', async () => {
    mocks.safeReadFile.mockResolvedValue([
      'OPENAI_API_KEY="profile-openai-key"',
      'OPENAI_BASE_URL=https://gateway.example/v1',
    ].join('\n'))
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/services/ekko-agent/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'work',
      provider: 'openai-api',
    })).resolves.toEqual({
      provider: 'openai-api',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'profile-openai-key',
      apiMode: 'codex_responses',
    })
    expect(mocks.safeReadFile).toHaveBeenCalledWith('/profiles/work/.env')
  })

  it('resolves custom provider credentials and protocol from profile config', async () => {
    mocks.readConfigYamlForProfile.mockResolvedValue({
      custom_providers: [{
        name: 'Summary Proxy',
        base_url: 'https://summary.example/v1',
        key_env: 'SUMMARY_PROXY_KEY',
        api_mode: 'anthropic_messages',
      }],
    })
    mocks.safeReadFile.mockResolvedValue("SUMMARY_PROXY_KEY='custom-key'")
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/services/ekko-agent/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'default',
      provider: 'custom:summary-proxy',
    })).resolves.toEqual({
      provider: 'custom:summary-proxy',
      baseUrl: 'https://summary.example/v1',
      apiKey: 'custom-key',
      apiMode: 'anthropic_messages',
    })
  })

  it('prefers explicit connection values over stored OAuth credentials', async () => {
    mocks.resolveAuthorized.mockResolvedValue({
      baseUrl: 'https://stored.example/v1',
      apiKey: 'stored-key',
    })
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/services/ekko-agent/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'default',
      provider: 'openai-codex',
      baseUrl: 'https://explicit.example/v1',
      apiKey: 'explicit-key',
      apiMode: 'codex_responses',
    })).resolves.toEqual({
      provider: 'openai-codex',
      baseUrl: 'https://explicit.example/v1',
      apiKey: 'explicit-key',
      apiMode: 'codex_responses',
    })
  })
})
