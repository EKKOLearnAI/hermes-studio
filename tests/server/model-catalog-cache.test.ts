import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockReadFile,
  mockFetchProviderModels,
  mockReadConfigYamlForProfile,
  mockReadText,
  mockUpdateText,
  mockListProfileNamesFromDisk,
  mockGetProfileDir,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockFetchProviderModels: vi.fn(),
  mockReadConfigYamlForProfile: vi.fn(),
  mockReadText: vi.fn(),
  mockUpdateText: vi.fn(),
  mockListProfileNamesFromDisk: vi.fn(),
  mockGetProfileDir: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}))

vi.mock('../../packages/server/src/config', () => ({
  config: { appHome: '/app-home' },
}))

vi.mock('../../packages/server/src/shared/providers', () => ({
  PROVIDER_PRESETS: [
    {
      value: 'openrouter',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      models: ['openrouter/fallback'],
    },
    {
      value: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
    },
  ],
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  PROVIDER_ENV_MAP: {
    openrouter: { api_key_env: 'OPENROUTER_API_KEY', base_url_env: 'OPENROUTER_BASE_URL' },
    deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' },
  },
  fetchProviderModels: mockFetchProviderModels,
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: mockGetProfileDir,
  listProfileNamesFromDisk: mockListProfileNamesFromDisk,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/services/safe-file-store', () => ({
  safeFileStore: {
    readText: mockReadText,
    updateText: mockUpdateText,
  },
}))

describe('model catalog cache', () => {
  let cacheText = ''

  beforeEach(() => {
    vi.clearAllMocks()
    cacheText = ''
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'team'])
    mockGetProfileDir.mockImplementation((profile: string) => `/hermes/${profile}`)
    mockReadText.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mockUpdateText.mockImplementation(async (_path: string, updater: (current: string) => string) => {
      cacheText = updater(cacheText)
    })
    mockFetchProviderModels.mockResolvedValue([])
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/hermes/default/.env') return 'OPENROUTER_API_KEY=default-openrouter\n'
      if (path === '/hermes/team/.env') {
        return [
          'OPENROUTER_API_KEY=team-openrouter',
          'DEEPSEEK_API_KEY=team-deepseek',
        ].join('\n')
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    mockReadConfigYamlForProfile.mockImplementation(async (profile: string) => {
      if (profile === 'default') {
        return {
          custom_providers: [
            { name: 'Shared Local', base_url: 'https://custom.local/v1', api_key: 'custom-a', model: 'local-a' },
          ],
        }
      }
      return {
        custom_providers: [
          { name: 'Shared Local', base_url: 'https://custom.local/v1', api_key: 'custom-b', model: 'local-b' },
        ],
      }
    })
  })

  it('refreshes providers from all profiles and deduplicates identical catalogs', async () => {
    const { refreshConfiguredProviderModelCatalogs, providerModelCatalogKey } = await import(
      '../../packages/server/src/services/hermes/model-catalog-cache'
    )

    await refreshConfiguredProviderModelCatalogs({ force: true })

    expect(mockFetchProviderModels).toHaveBeenCalledTimes(3)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://openrouter.ai/api/v1', 'default-openrouter', true)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://api.deepseek.com/v1', 'team-deepseek', false)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://custom.local/v1', 'custom-a', false)

    const cache = JSON.parse(cacheText)
    expect(cache.providers[providerModelCatalogKey('openrouter', 'https://openrouter.ai/api/v1', true)]).toMatchObject({
      provider: 'openrouter',
      models: ['openrouter/fallback'],
      profiles: ['default', 'team'],
    })
    expect(cache.providers[providerModelCatalogKey('deepseek', 'https://api.deepseek.com/v1')]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-chat'],
      profiles: ['team'],
    })
    expect(cache.providers[providerModelCatalogKey('custom:shared-local', 'https://custom.local/v1')]).toMatchObject({
      provider: 'custom:shared-local',
      models: ['local-a', 'local-b'],
      profiles: ['default', 'team'],
    })
  })
})
