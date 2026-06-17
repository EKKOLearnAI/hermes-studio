import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockReadFile,
  mockFetchProviderModels,
  mockReadConfigYamlForProfile,
  mockReadText,
  mockUpdateText,
  mockListProfileNamesFromDisk,
  mockGetProfileDir,
  mockReadAppConfig,
  mockResolveCopilotOAuthToken,
  mockGlobalFetch,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockFetchProviderModels: vi.fn(),
  mockReadConfigYamlForProfile: vi.fn(),
  mockReadText: vi.fn(),
  mockUpdateText: vi.fn(),
  mockListProfileNamesFromDisk: vi.fn(),
  mockGetProfileDir: vi.fn(),
  mockReadAppConfig: vi.fn(),
  mockResolveCopilotOAuthToken: vi.fn(),
  mockGlobalFetch: vi.fn(),
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
    {
      value: 'openai-codex',
      label: 'OpenAI Codex',
      base_url: 'https://chatgpt.com/backend-api/codex',
      models: ['gpt-5.5', 'gpt-5.4-mini'],
    },
    {
      value: 'xai-oauth',
      label: 'xAI Grok OAuth',
      base_url: 'https://api.x.ai/v1',
      models: ['grok-4.3'],
    },
    {
      value: 'copilot',
      label: 'GitHub Copilot',
      base_url: 'https://api.githubcopilot.com',
      models: ['gpt-5.5', 'claude-sonnet-4.6'],
    },
    {
      value: 'nous',
      label: 'Nous Portal',
      base_url: 'https://inference-api.nousresearch.com/v1',
      models: ['anthropic/claude-opus-4.8'],
    },
    {
      value: 'google-gemini-cli',
      label: 'Google Gemini OAuth',
      base_url: 'cloudcode-pa://google',
      models: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview'],
    },
    {
      value: 'claude-oauth',
      label: 'Claude OAuth',
      base_url: 'https://api.anthropic.com',
      models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
    },
  ],
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  PROVIDER_ENV_MAP: {
    openrouter: { api_key_env: 'OPENROUTER_API_KEY', base_url_env: 'OPENROUTER_BASE_URL' },
    deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' },
    'openai-codex': { api_key_env: '', base_url_env: '' },
    'xai-oauth': { api_key_env: '', base_url_env: '' },
    copilot: { api_key_env: 'GITHUB_TOKEN', base_url_env: '' },
    nous: { api_key_env: '', base_url_env: '' },
    'google-gemini-cli': { api_key_env: '', base_url_env: '' },
    'claude-oauth': { api_key_env: '', base_url_env: '' },
  },
  fetchProviderModels: mockFetchProviderModels,
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
}))

vi.mock('../../packages/server/src/services/app-config', () => ({
  readAppConfig: mockReadAppConfig,
}))

vi.mock('../../packages/server/src/services/hermes/copilot-models', () => ({
  resolveCopilotOAuthToken: mockResolveCopilotOAuthToken,
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
    mockReadAppConfig.mockResolvedValue({})
    mockResolveCopilotOAuthToken.mockResolvedValue('')
    mockFetchProviderModels.mockResolvedValue([])
    mockGlobalFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    vi.stubGlobal('fetch', mockGlobalFetch)
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

  it('adds authorized providers to the catalog cache and fetches live models for compatible auth providers', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default'])
    mockReadAppConfig.mockResolvedValue({ copilotEnabled: true })
    mockResolveCopilotOAuthToken.mockResolvedValue('gho-copilot')
    mockGlobalFetch.mockImplementation(async (url: string) => {
      if (url === 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0') {
        return {
          ok: true,
          json: async () => ({
            models: [
              { slug: 'hidden-codex', visibility: 'hidden', priority: 0 },
              { slug: 'gpt-5.4-mini', priority: 20 },
              { slug: 'gpt-5.5', priority: 10 },
            ],
          }),
        }
      }
      if (url === 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
        return {
          ok: true,
          json: async () => ({
            buckets: [
              { modelId: 'gemini-3.1-pro-preview' },
              { modelId: 'gemini-3-flash-preview' },
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    mockFetchProviderModels.mockImplementation(async (baseUrl: string, apiKey: string) => {
      if (baseUrl === 'https://inference-api.nousresearch.com/v1' && apiKey === 'nous-agent-key') {
        return ['nous/live-a', 'nous/live-b']
      }
      if (baseUrl === 'https://api.x.ai/v1' && apiKey === 'xai-access-token') {
        return ['grok-live-a', 'grok-live-b']
      }
      return []
    })
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/hermes/default/.env') return ''
      if (path === '/hermes/default/auth.json') {
        return JSON.stringify({
          providers: {
            'openai-codex': { tokens: { access_token: 'codex-token' } },
            'google-gemini-cli': {
              access_token: 'gemini-access-token',
              refresh_token: 'gemini-refresh-token',
              base_url: 'cloudcode-pa://google',
            },
            'claude-oauth': {
              tokens: {
                access_token: 'claude-access-token',
                refresh_token: 'claude-refresh-token',
              },
              base_url: 'https://api.anthropic.com',
            },
          },
          credential_pool: {
            'xai-oauth': [{ access_token: 'xai-access-token' }],
            nous: [{
              agent_key: 'nous-agent-key',
              inference_base_url: 'https://inference-api.nousresearch.com/v1',
            }],
          },
        })
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    mockReadConfigYamlForProfile.mockResolvedValue({})

    const { refreshConfiguredProviderModelCatalogs, providerModelCatalogKey } = await import(
      '../../packages/server/src/services/hermes/model-catalog-cache'
    )

    await refreshConfiguredProviderModelCatalogs({ force: true })

    expect(mockFetchProviderModels).toHaveBeenCalledTimes(2)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://inference-api.nousresearch.com/v1', 'nous-agent-key', false)
    expect(mockFetchProviderModels).toHaveBeenCalledWith('https://api.x.ai/v1', 'xai-access-token', false)
    const cache = JSON.parse(cacheText)
    expect(cache.providers[providerModelCatalogKey('openai-codex', 'https://chatgpt.com/backend-api/codex')]).toMatchObject({
      provider: 'openai-codex',
      models: ['gpt-5.5', 'gpt-5.4-mini'],
      source: 'live',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('xai-oauth', 'https://api.x.ai/v1')]).toMatchObject({
      provider: 'xai-oauth',
      models: ['grok-live-a', 'grok-live-b'],
      source: 'live',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('copilot', 'https://api.githubcopilot.com')]).toMatchObject({
      provider: 'copilot',
      models: ['gpt-5.5', 'claude-sonnet-4.6'],
      source: 'fallback',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('nous', 'https://inference-api.nousresearch.com/v1')]).toMatchObject({
      provider: 'nous',
      models: ['nous/live-a', 'nous/live-b'],
      source: 'live',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('google-gemini-cli', 'cloudcode-pa://google')]).toMatchObject({
      provider: 'google-gemini-cli',
      models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
      source: 'live',
      profiles: ['default'],
    })
    expect(cache.providers[providerModelCatalogKey('claude-oauth', 'https://api.anthropic.com')]).toMatchObject({
      provider: 'claude-oauth',
      models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
      source: 'fallback',
      profiles: ['default'],
    })
  })
})
