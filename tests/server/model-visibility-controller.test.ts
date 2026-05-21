import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadFile, mockReadConfigYaml, mockReadConfigYamlForProfile, mockFetchProviderModels, mockBuildModelGroups, mockListConfiguredProviderModels, mockReadAppConfig, mockWriteAppConfig, mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockReadConfigYaml: vi.fn(),
  mockReadConfigYamlForProfile: vi.fn(),
  mockFetchProviderModels: vi.fn(),
  mockBuildModelGroups: vi.fn(() => ({ default: '', groups: [] })),
  mockListConfiguredProviderModels: vi.fn((config: any) => {
    if (!config?.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)) return []
    return Object.entries(config.providers).flatMap(([provider, raw]: [string, any]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      const models = new Set<string>()
      if (raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
        Object.keys(raw.models).forEach(model => { if (model) models.add(model) })
      } else if (Array.isArray(raw.models)) {
        raw.models.forEach((model: any) => { if (model) models.add(String(model)) })
      }
      if (raw.default_model) models.add(String(raw.default_model))
      if (config.model?.provider === provider && (config.model?.default || config.model?.model)) models.add(String(config.model.default || config.model.model))
      const keyEnv = String(raw.key_env || '').trim()
      return models.size > 0 ? [{
        provider,
        label: raw.name || provider,
        base_url: raw.base_url || raw.api || '',
        key_env: /^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv) ? keyEnv : '',
        models: [...models],
      }] : []
    })
  }),
  mockReadAppConfig: vi.fn(),
  mockWriteAppConfig: vi.fn(),
  mockExistsSync: vi.fn(() => false),
  mockReadFileSync: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}))

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveEnvPath: () => '/fake/home/.hermes/.env',
  getActiveAuthPath: () => '/fake/home/.hermes/auth.json',
  getActiveProfileName: () => 'default',
  getProfileDir: () => '/fake/home/.hermes',
  listProfileNamesFromDisk: () => ['default'],
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYaml: mockReadConfigYaml,
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
  writeConfigYaml: vi.fn(),
  fetchProviderModels: mockFetchProviderModels,
  buildModelGroups: mockBuildModelGroups,
  listConfiguredProviderModels: mockListConfiguredProviderModels,
  PROVIDER_ENV_MAP: {
    deepseek: { api_key_env: 'DEEPSEEK_API_KEY' },
    'xai-oauth': { api_key_env: '', base_url_env: 'XAI_BASE_URL' },
    openrouter: {},
  },
}))

vi.mock('../../packages/server/src/shared/providers', () => ({
  buildProviderModelMap: () => ({
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    'xai-oauth': ['grok-4.3', 'grok-4.20-0309-reasoning'],
    openrouter: ['openrouter/auto'],
  }),
  PROVIDER_PRESETS: [
    {
      value: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
    {
      value: 'openrouter',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      models: ['openrouter/auto'],
    },
    {
      value: 'xai-oauth',
      label: 'xAI Grok OAuth (SuperGrok Subscription)',
      base_url: 'https://api.x.ai/v1',
      models: ['grok-4.3', 'grok-4.20-0309-reasoning'],
    },
  ],
}))

vi.mock('../../packages/server/src/services/hermes/copilot-models', () => ({
  getCopilotModelsDetailed: vi.fn(async () => []),
  resolveCopilotOAuthToken: vi.fn(async () => ''),
}))

vi.mock('../../packages/server/src/services/app-config', () => ({
  readAppConfig: mockReadAppConfig,
  writeAppConfig: mockWriteAppConfig,
}))

vi.mock('../../packages/server/src/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/schemas', () => ({
  MODEL_CONTEXT_TABLE: 'model_context',
}))

import * as ctrl from '../../packages/server/src/controllers/hermes/models'

function makeCtx(body: Record<string, unknown> = {}): any {
  return { params: {}, query: {}, request: { body }, body: undefined, status: 200 }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReadFile.mockResolvedValue('DEEPSEEK_API_KEY=sk-test\n')
  mockReadConfigYaml.mockResolvedValue({ model: { default: 'deepseek-chat', provider: 'deepseek' } })
  mockReadConfigYamlForProfile.mockResolvedValue({ model: { default: 'deepseek-chat', provider: 'deepseek' } })
  mockBuildModelGroups.mockReturnValue({ default: '', groups: [] })
  mockListConfiguredProviderModels.mockClear()
  mockReadAppConfig.mockResolvedValue({})
  mockWriteAppConfig.mockImplementation(async patch => patch)
  mockExistsSync.mockReturnValue(false)
  mockReadFileSync.mockReturnValue('{}')
})

describe('models controller — model visibility', () => {
  it('filters available models per provider without changing canonical IDs', async () => {
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toHaveLength(1)
    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-reasoner'],
      available_models: ['deepseek-chat', 'deepseek-reasoner'],
    })
    expect(ctx.body.default).toBe('deepseek-reasoner')
    expect(ctx.body.default_provider).toBe('deepseek')
    expect(ctx.body.model_visibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
    })
  })
  it('accepts OAuth providers stored in credential_pool entries', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      credential_pool: {
        openrouter: [{ label: 'primary', access_token: 'oauth-token' }],
      },
    }))

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openrouter',
        label: 'OpenRouter',
        models: ['openrouter/auto'],
        available_models: ['openrouter/auto'],
      }),
    ]))
  })

  it('shows xAI Grok OAuth when SuperGrok credentials exist in auth.json', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      providers: {
        'xai-oauth': {
          tokens: { access_token: 'xai-token' },
        },
      },
    }))

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'xai-oauth',
        label: 'xAI Grok OAuth (SuperGrok Subscription)',
        base_url: 'https://api.x.ai/v1',
        models: ['grok-4.3', 'grok-4.20-0309-reasoning'],
      }),
    ]))
  })

  it('discovers available models from Hermes config.providers entries', async () => {
    mockReadFile.mockResolvedValue('CUSTOM_RELAY_API_KEY=sk-test\n')
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'custom-model-pro', provider: 'customrelay' },
      providers: {
        customrelay: {
          name: 'Custom Relay',
          base_url: 'https://relay.example/v1',
          key_env: 'CUSTOM_RELAY_API_KEY',
          default_model: 'custom-model-pro',
          models: {
            'custom-model-pro': { reasoning_effort: 'xhigh' },
            'custom-model-lite': {},
          },
        },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.default).toBe('custom-model-pro')
    expect(ctx.body.default_provider).toBe('customrelay')
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'customrelay',
        label: 'Custom Relay',
        base_url: 'https://relay.example/v1',
        models: ['custom-model-pro', 'custom-model-lite'],
        available_models: ['custom-model-pro', 'custom-model-lite'],
        api_key: 'sk-test',
      }),
    ]))
    expect(ctx.body.profiles[0]).toEqual(expect.objectContaining({
      profile: 'default',
      default: 'custom-model-pro',
      default_provider: 'customrelay',
      groups: expect.arrayContaining([
        expect.objectContaining({ provider: 'customrelay' }),
      ]),
    }))
  })

  it('merges config.providers models into matching builtin provider groups', async () => {
    mockReadFile.mockResolvedValue('DEEPSEEK_API_KEY=sk-test\n')
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'deepseek-coder-v3', provider: 'deepseek' },
      providers: {
        deepseek: {
          key_env: 'DEEPSEEK_API_KEY',
          default_model: 'deepseek-coder-v3',
          models: {
            'deepseek-coder-v3': {},
          },
        },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    const group = ctx.body.groups.find((g: any) => g.provider === 'deepseek')
    expect(group).toMatchObject({
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-test',
      builtin: true,
    })
    expect(group.models).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder-v3'])
    expect(group.available_models).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder-v3'])
    expect(ctx.body.default).toBe('deepseek-coder-v3')
    expect(ctx.body.default_provider).toBe('deepseek')
  })

  it('ignores invalid key_env names from config.providers entries', async () => {
    mockReadFile.mockResolvedValue('CUSTOM_RELAY_API_KEY=sk-test\n')
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { default: 'relay-model', provider: 'relay' },
      providers: {
        relay: {
          key_env: 'CUSTOM_RELAY_API_KEY|MALICIOUS',
          models: { 'relay-model': {} },
        },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'relay',
        models: ['relay-model'],
        api_key: '',
      }),
    ]))
  })

  it('uses model.model as the visible default for config.providers entries', async () => {
    mockReadFile.mockResolvedValue('CUSTOM_RELAY_API_KEY=sk-test\n')
    mockReadConfigYamlForProfile.mockResolvedValue({
      model: { model: 'relay-model', provider: 'relay' },
      providers: {
        relay: {
          key_env: 'CUSTOM_RELAY_API_KEY',
        },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.default).toBe('relay-model')
    expect(ctx.body.default_provider).toBe('relay')
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'relay',
        models: ['relay-model'],
      }),
    ]))
  })

  it('fails open for stale include rules so a provider can be recovered in the UI', async () => {
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: { mode: 'include', models: ['missing-model'] },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      available_models: ['deepseek-chat', 'deepseek-reasoner'],
    })
  })

  it('applies visibility to the config fallback path when no credentialed providers are active', async () => {
    mockReadFile.mockResolvedValue('')
    mockReadConfigYaml.mockResolvedValue({
      model: { default: 'custom-a' },
      custom_providers: [
        { name: 'local', model: 'custom-a' },
        { name: 'local', model: 'custom-b' },
      ],
    })
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        Custom: { mode: 'include', models: ['custom-b'] },
      },
    })
    mockBuildModelGroups.mockReturnValue({
      default: 'custom-a',
      groups: [
        {
          provider: 'Custom',
          models: [
            { id: 'custom-a', label: 'local: custom-a' },
            { id: 'custom-b', label: 'local: custom-b' },
          ],
        },
      ],
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups).toEqual([
      expect.objectContaining({
        provider: 'Custom',
        models: ['custom-b'],
        available_models: ['custom-a', 'custom-b'],
      }),
    ])
    expect(ctx.body.default).toBe('custom-b')
    expect(ctx.body.default_provider).toBe('Custom')
  })

  it('saves include visibility in web-ui app config only', async () => {
    mockReadAppConfig.mockResolvedValue({ copilotEnabled: true })
    mockWriteAppConfig.mockResolvedValue({
      copilotEnabled: true,
      modelVisibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })

    const ctx = makeCtx({ provider: 'deepseek', mode: 'include', models: ['deepseek-chat', 'deepseek-chat', ''] })
    await ctrl.setModelVisibility(ctx)

    expect(mockWriteAppConfig).toHaveBeenCalledWith({
      modelVisibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })
    expect(ctx.body).toEqual({
      success: true,
      model_visibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })
  })

  it('resets a provider to all models by deleting its web-ui visibility rule', async () => {
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: { mode: 'include', models: ['deepseek-chat'] },
        openrouter: { mode: 'include', models: ['x'] },
      },
    })
    mockWriteAppConfig.mockResolvedValue({
      modelVisibility: {
        openrouter: { mode: 'include', models: ['x'] },
      },
    })

    const ctx = makeCtx({ provider: 'deepseek', mode: 'all', models: [] })
    await ctrl.setModelVisibility(ctx)

    expect(mockWriteAppConfig).toHaveBeenCalledWith({
      modelVisibility: {
        openrouter: { mode: 'include', models: ['x'] },
      },
    })
    expect(ctx.body.model_visibility).toEqual({
      openrouter: { mode: 'include', models: ['x'] },
    })
  })

  it('rejects empty include lists', async () => {
    const ctx = makeCtx({ provider: 'deepseek', mode: 'include', models: [] })
    await ctrl.setModelVisibility(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Select at least one model' })
    expect(mockWriteAppConfig).not.toHaveBeenCalled()
  })
})
