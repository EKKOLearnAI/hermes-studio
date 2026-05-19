import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadFile, mockReadConfigYaml, mockFetchProviderModels, mockBuildModelGroups, mockReadAppConfig, mockWriteAppConfig, mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockReadConfigYaml: vi.fn(),
  mockFetchProviderModels: vi.fn(),
  mockBuildModelGroups: vi.fn(() => ({ default: '', groups: [] })),
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
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYaml: mockReadConfigYaml,
  writeConfigYaml: vi.fn(),
  fetchProviderModels: mockFetchProviderModels,
  buildModelGroups: mockBuildModelGroups,
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
  mockBuildModelGroups.mockReturnValue({ default: '', groups: [] })
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
