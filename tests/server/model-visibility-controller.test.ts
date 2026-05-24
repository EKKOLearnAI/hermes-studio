import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadFile, mockReadConfigYaml, mockReadConfigYamlForProfile, mockFetchProviderModels, mockBuildModelGroups, mockReadAppConfig, mockWriteAppConfig, mockExistsSync, mockReadFileSync, mockListProfileNamesFromDisk, mockListUserProfiles } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockReadConfigYaml: vi.fn(),
  mockReadConfigYamlForProfile: vi.fn(),
  mockFetchProviderModels: vi.fn(),
  mockBuildModelGroups: vi.fn(() => ({ default: '', groups: [] })),
  mockReadAppConfig: vi.fn(),
  mockWriteAppConfig: vi.fn(),
  mockExistsSync: vi.fn(() => false),
  mockReadFileSync: vi.fn(),
  mockListProfileNamesFromDisk: vi.fn(() => ['default']),
  mockListUserProfiles: vi.fn(() => []),
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
  listProfileNamesFromDisk: mockListProfileNamesFromDisk,
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles: mockListUserProfiles,
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYaml: mockReadConfigYaml,
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
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
  mockReadConfigYamlForProfile.mockResolvedValue({ model: { default: 'deepseek-chat', provider: 'deepseek' } })
  mockBuildModelGroups.mockReturnValue({ default: '', groups: [] })
  mockReadAppConfig.mockResolvedValue({})
  mockWriteAppConfig.mockImplementation(async patch => patch)
  mockExistsSync.mockReturnValue(false)
  mockReadFileSync.mockReturnValue('{}')
  mockListProfileNamesFromDisk.mockReturnValue(['default'])
  mockListUserProfiles.mockReturnValue([])
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

  it('merges Web UI custom models into available provider groups', async () => {
    mockReadAppConfig.mockResolvedValue({
      customModels: {
        deepseek: ['gemma-4-26b-a4b-it', 'deepseek-chat'],
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner', 'gemma-4-26b-a4b-it'],
      available_models: ['deepseek-chat', 'deepseek-reasoner', 'gemma-4-26b-a4b-it'],
    })
    expect(ctx.body.custom_models).toEqual({
      deepseek: ['gemma-4-26b-a4b-it', 'deepseek-chat'],
    })
  })

  it('limits the default available-models response to profiles bound to regular admins', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'research', 'private'])
    mockListUserProfiles.mockReturnValue([
      { user_id: 7, profile_name: 'research', is_default: 1, created_at: 1 },
    ])
    mockReadConfigYamlForProfile.mockImplementation(async (profile: string) => ({
      model: {
        default: `${profile}-model`,
        provider: 'deepseek',
      },
    }))

    const ctx = makeCtx()
    ctx.state = { user: { id: 7, username: 'ops', role: 'admin' } }
    ctx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'private' : '')
    await ctrl.getAvailable(ctx)

    expect(mockReadConfigYamlForProfile).toHaveBeenCalledTimes(1)
    expect(mockReadConfigYamlForProfile).toHaveBeenCalledWith('research')
    expect(ctx.body.profiles.map((profile: any) => profile.profile)).toEqual(['research'])
    expect(ctx.body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'deepseek' }),
    ]))
  })

  it('uses the requested profile for aggregate response defaults', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'tester'])
    mockReadConfigYamlForProfile.mockImplementation(async (profile: string) => ({
      model: {
        default: profile === 'tester' ? 'deepseek-reasoner' : 'deepseek-chat',
        provider: 'deepseek',
      },
    }))

    const ctx = makeCtx()
    ctx.state = { user: { id: 1, username: 'admin', role: 'super_admin' } }
    ctx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'tester' : '')
    await ctrl.getAvailable(ctx)

    expect(ctx.body.default).toBe('deepseek-reasoner')
    expect(ctx.body.default_provider).toBe('deepseek')
    expect(ctx.body.profiles.map((profile: any) => profile.profile)).toEqual(['default', 'tester'])
  })

  it('uses explicit query profile for single-profile model fetches', async () => {
    mockListProfileNamesFromDisk.mockReturnValue(['default', 'research'])

    const ctx = makeCtx()
    ctx.query = { profile: 'research' }
    ctx.state = { profile: { name: 'default' }, user: { id: 1, username: 'admin', role: 'super_admin' } }
    await ctrl.getAvailable(ctx)

    expect(mockReadConfigYamlForProfile).toHaveBeenCalledTimes(1)
    expect(mockReadConfigYamlForProfile).toHaveBeenCalledWith('research')
    expect(ctx.body.profiles.map((profile: any) => profile.profile)).toEqual(['research'])
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

  it('adds and removes custom models in web-ui app config only', async () => {
    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })

    const addCtx = makeCtx({ provider: 'deepseek', model: 'manual-model' })
    await ctrl.addCustomModel(addCtx)

    expect(mockWriteAppConfig).toHaveBeenCalledWith({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })
    expect(addCtx.body).toEqual({
      success: true,
      custom_models: { deepseek: ['existing', 'manual-model'] },
    })

    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing'] },
    })

    const removeCtx = makeCtx({ provider: 'deepseek', model: 'manual-model' })
    await ctrl.removeCustomModel(removeCtx)

    expect(mockWriteAppConfig).toHaveBeenLastCalledWith({
      customModels: { deepseek: ['existing'] },
    })
    expect(removeCtx.body).toEqual({
      success: true,
      custom_models: { deepseek: ['existing'] },
    })
  })

  it('removes custom models from query params when DELETE body is missing', async () => {
    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['manual-model'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: {},
    })

    const ctx = makeCtx()
    ctx.request.body = undefined
    ctx.query = { provider: 'deepseek', model: 'manual-model' }

    await ctrl.removeCustomModel(ctx)

    expect(ctx.status).toBe(200)
    expect(mockWriteAppConfig).toHaveBeenCalledWith({ customModels: {} })
    expect(ctx.body).toEqual({ success: true, custom_models: {} })
  })

  it('rejects empty include lists', async () => {
    const ctx = makeCtx({ provider: 'deepseek', mode: 'include', models: [] })
    await ctrl.setModelVisibility(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Select at least one model' })
    expect(mockWriteAppConfig).not.toHaveBeenCalled()
  })
})
