import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  restartGateway: vi.fn().mockResolvedValue(undefined),
}))

let hermesHome = ''

async function loadProvidersController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/providers')
}

function makeCtx(poolKey: string, body: Record<string, any>, profile = 'research') {
  return {
    params: { poolKey: encodeURIComponent(poolKey) },
    request: { body },
    state: { profile: { name: profile } },
    status: 200,
    body: undefined as unknown,
  }
}

function readYaml(filePath: string) {
  return YAML.load(readFileSync(filePath, 'utf-8')) as any
}

describe('providers controller update', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-provider-update-'))
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: deepseek\n  default: keep-default-model\n')
    writeFileSync(join(hermesHome, '.env'), [
      'DEEPSEEK_API_KEY=keep-default-key',
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'profiles', 'research', 'config.yaml'), [
      'model:',
      '  provider: custom:research-proxy',
      '  default: research-model',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://research.invalid/v1',
      '    api_key: old-research-custom-key',
      '    model: research-model',
      '  - name: env-proxy',
      '    base_url: https://env.invalid/v1',
      '    key_env: CUSTOM_PROXY_KEY',
      '    model: env-model',
      '  - name: mixed-proxy',
      '    base_url: https://mixed.invalid/v1',
      '    api_key: old-mixed-inline-key',
      '    key_env: MIXED_PROXY_KEY',
      '    model: mixed-model',
      'providers:',
      '  dict-proxy:',
      '    name: dict-proxy',
      '    base_url: https://dict.invalid/v1',
      '    api_key: old-dict-key',
      '    model: dict-model',
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'profiles', 'research', '.env'), [
      'DEEPSEEK_API_KEY=old-research-key',
      'CUSTOM_PROXY_KEY=old-custom-env-key',
      'MIXED_PROXY_KEY=old-mixed-env-key',
      '',
    ].join('\n'))
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    vi.doUnmock('../../packages/server/src/controllers/hermes/providers')
    vi.clearAllMocks()
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('updates built-in provider API keys in the request-scoped profile env only', async () => {
    const { update } = await loadProvidersController()
    const ctx = makeCtx('deepseek', { api_key: 'new-research-key' })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(readFileSync(join(hermesHome, '.env'), 'utf-8')).toContain('DEEPSEEK_API_KEY=keep-default-key')
    expect(readFileSync(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')).toContain('DEEPSEEK_API_KEY=new-research-key')
  })

  it('updates custom provider API keys in the request-scoped profile config only', async () => {
    const defaultConfigPath = join(hermesHome, 'config.yaml')
    writeFileSync(defaultConfigPath, [
      'model:',
      '  provider: custom:research-proxy',
      '  default: default-model',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://default.invalid/v1',
      '    api_key: keep-default-custom-key',
      '    model: default-model',
      '',
    ].join('\n'))

    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:research-proxy', { api_key: 'new-research-custom-key' })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const defaultConfig = readYaml(defaultConfigPath)
    const researchConfig = readYaml(join(hermesHome, 'profiles', 'research', 'config.yaml'))
    expect(defaultConfig.custom_providers[0].api_key).toBe('keep-default-custom-key')
    expect(researchConfig.custom_providers[0].api_key).toBe('new-research-custom-key')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats a %s builtin credential replacement as a successful no-op', async (_label, value) => {
    const envPath = join(hermesHome, 'profiles', 'research', '.env')
    const before = readFileSync(envPath, 'utf-8')
    const { update } = await loadProvidersController()
    const ctx = makeCtx('deepseek', { api_key: value })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(readFileSync(envPath, 'utf-8')).toBe(before)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats a %s list-backed custom credential replacement as a successful no-op', async (_label, value) => {
    const configPath = join(hermesHome, 'profiles', 'research', 'config.yaml')
    const before = readYaml(configPath)
    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:research-proxy', { api_key: value, provider_source: 'custom_providers' })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(readYaml(configPath)).toEqual(before)
  })

  it.each([
    ['dict undefined', 'custom:dict-proxy', 'providers', 'dict-proxy', undefined],
    ['dict null', 'custom:dict-proxy', 'providers', 'dict-proxy', null],
    ['dict empty', 'custom:dict-proxy', 'providers', 'dict-proxy', ''],
    ['dict whitespace', 'custom:dict-proxy', 'providers', 'dict-proxy', '   '],
    ['env undefined', 'custom:env-proxy', 'custom_providers', '', undefined],
    ['env null', 'custom:env-proxy', 'custom_providers', '', null],
    ['env empty', 'custom:env-proxy', 'custom_providers', '', ''],
    ['env whitespace', 'custom:env-proxy', 'custom_providers', '', '   '],
  ])('treats a %s replacement as a no-op at the original source', async (_label, poolKey, source, providerKey, value) => {
    const configPath = join(hermesHome, 'profiles', 'research', 'config.yaml')
    const envPath = join(hermesHome, 'profiles', 'research', '.env')
    const configBefore = readYaml(configPath)
    const envBefore = readFileSync(envPath, 'utf-8')
    const { update } = await loadProvidersController()
    const ctx = makeCtx(poolKey, {
      api_key: value,
      provider_source: source,
      ...(providerKey ? { provider_key: providerKey } : {}),
    })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(readYaml(configPath)).toEqual(configBefore)
    expect(readFileSync(envPath, 'utf-8')).toBe(envBefore)
  })

  it('updates the exact dict-backed custom source and leaves same-profile siblings unchanged', async () => {
    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:dict-proxy', {
      api_key: 'new-dict-key',
      provider_source: 'providers',
      provider_key: 'dict-proxy',
    })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const config = readYaml(join(hermesHome, 'profiles', 'research', 'config.yaml'))
    expect(config.providers['dict-proxy'].api_key).toBe('new-dict-key')
    expect(config.custom_providers[0].api_key).toBe('old-research-custom-key')
  })

  it('updates an env-backed custom credential at its referenced env source', async () => {
    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:env-proxy', {
      api_key: 'new-custom-env-key',
      provider_source: 'custom_providers',
    })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const config = readYaml(join(hermesHome, 'profiles', 'research', 'config.yaml'))
    expect(config.custom_providers[1]).toMatchObject({ key_env: 'CUSTOM_PROXY_KEY' })
    expect(config.custom_providers[1]).not.toHaveProperty('api_key')
    expect(readFileSync(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')).toContain('CUSTOM_PROXY_KEY=new-custom-env-key')
  })

  it('rotates the active inline credential when a custom provider also declares key_env', async () => {
    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:mixed-proxy', {
      api_key: 'new-mixed-inline-key',
      provider_source: 'custom_providers',
    })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const config = readYaml(join(hermesHome, 'profiles', 'research', 'config.yaml'))
    expect(config.custom_providers[2]).toMatchObject({
      api_key: 'new-mixed-inline-key',
      key_env: 'MIXED_PROXY_KEY',
    })
    expect(readFileSync(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')).toContain('MIXED_PROXY_KEY=old-mixed-env-key')
  })

  it.each([
    ['unknown source', { provider_source: 'providerz' }],
    ['list source with dict key', { provider_source: 'custom_providers', provider_key: 'dict-proxy' }],
    ['dict source without dict key', { provider_source: 'providers' }],
  ])('rejects a fail-open custom source selector: %s', async (_label, selector) => {
    const configPath = join(hermesHome, 'profiles', 'research', 'config.yaml')
    const before = readFileSync(configPath, 'utf-8')
    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:research-proxy', {
      api_key: 'must-not-be-written',
      ...selector,
    })

    await update(ctx)

    expect(ctx.status).toBe(400)
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  it('keeps builtin and same-named custom update identities isolated', async () => {
    const configPath = join(hermesHome, 'profiles', 'research', 'config.yaml')
    const config = readYaml(configPath)
    config.custom_providers.push({
      name: 'deepseek',
      base_url: 'https://custom-deepseek.invalid/v1',
      api_key: 'old-custom-deepseek-key',
      model: 'custom-deepseek-model',
    })
    writeFileSync(configPath, YAML.dump(config))
    const envPath = join(hermesHome, 'profiles', 'research', '.env')
    const envBefore = readFileSync(envPath, 'utf-8')
    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:deepseek', {
      api_key: 'new-custom-deepseek-key',
      provider_source: 'custom_providers',
    })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const updated = readYaml(configPath)
    expect(updated.custom_providers.find((entry: any) => entry.name === 'deepseek').api_key).toBe('new-custom-deepseek-key')
    expect(readFileSync(envPath, 'utf-8')).toBe(envBefore)
  })

  it.each(['', 'custom:', 'custom:bad key'])('rejects invalid provider identity %j with 400', async (poolKey) => {
    const { update } = await loadProvidersController()
    const ctx = makeCtx(poolKey, { api_key: 'replacement-value' })

    await update(ctx)

    expect(ctx.status).toBe(400)
  })

  it('updates custom provider api_mode in the request-scoped profile config only', async () => {
    const defaultConfigPath = join(hermesHome, 'config.yaml')
    writeFileSync(defaultConfigPath, [
      'model:',
      '  provider: custom:research-proxy',
      '  default: default-model',
      'custom_providers:',
      '  - name: research-proxy',
      '    base_url: https://default.invalid/v1',
      '    api_key: keep-default-custom-key',
      '    model: default-model',
      '    api_mode: codex_responses',
      '',
    ].join('\n'))

    const { update } = await loadProvidersController()
    const ctx = makeCtx('custom:research-proxy', { api_mode: 'chat_completions' })

    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const defaultConfig = readYaml(defaultConfigPath)
    const researchConfig = readYaml(join(hermesHome, 'profiles', 'research', 'config.yaml'))
    expect(defaultConfig.custom_providers[0].api_mode).toBe('codex_responses')
    expect(researchConfig.custom_providers[0].api_mode).toBe('chat_completions')
  })
})
