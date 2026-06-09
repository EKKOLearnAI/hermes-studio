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

function makeCtx(body: Record<string, any>, profile = 'default') {
  return {
    request: { body },
    state: { profile: { name: profile } },
    status: 200,
    body: undefined as unknown,
  }
}

function readYaml(filePath: string) {
  return YAML.load(readFileSync(filePath, 'utf-8')) as any
}

describe('providers controller create', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-provider-create-'))
    mkdirSync(hermesHome, { recursive: true })
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: {}\n')
    writeFileSync(join(hermesHome, '.env'), '')
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    vi.doUnmock('../../packages/server/src/controllers/hermes/providers')
    vi.clearAllMocks()
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('does not persist a built-in provider base URL when it matches the preset default', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      api_key: 'deepseek-key',
      model: 'deepseek-chat',
      providerKey: 'deepseek',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const envAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(envAfter).toContain('DEEPSEEK_API_KEY=deepseek-key')
    expect(envAfter).not.toContain('DEEPSEEK_BASE_URL')
  })

  it('persists a built-in provider base URL when it differs from the preset default', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'DeepSeek',
      base_url: 'https://deepseek-proxy.invalid/v1',
      api_key: 'deepseek-key',
      model: 'deepseek-chat',
      providerKey: 'deepseek',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const envAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(envAfter).toContain('DEEPSEEK_API_KEY=deepseek-key')
    expect(envAfter).toContain('DEEPSEEK_BASE_URL=https://deepseek-proxy.invalid/v1')
  })

  it('creates Atlas Cloud as a built-in API-key provider', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'Atlas Cloud',
      base_url: 'https://api.atlascloud.ai/v1',
      api_key: 'atlas-key',
      model: 'deepseek-ai/deepseek-v4-pro',
      providerKey: 'atlascloud',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readYaml(join(hermesHome, 'config.yaml'))
    expect(configAfter.model).toEqual({ default: 'deepseek-ai/deepseek-v4-pro', provider: 'atlascloud' })
    expect(configAfter.custom_providers).toBeUndefined()
    const envAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(envAfter).toContain('ATLASCLOUD_API_KEY=atlas-key')
    expect(envAfter).not.toContain('ATLASCLOUD_BASE_URL')
  })

  it('creates xAI OAuth as a direct config provider without an API key or custom provider entry', async () => {
    const { create } = await loadProvidersController()
    const ctx = makeCtx({
      name: 'xAI Grok OAuth',
      base_url: 'https://api.x.ai/v1',
      api_key: '',
      model: 'grok-4.3',
      providerKey: 'xai-oauth',
    })

    await create(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readYaml(join(hermesHome, 'config.yaml'))
    expect(configAfter.model).toEqual({ default: 'grok-4.3', provider: 'xai-oauth' })
    expect(configAfter.custom_providers).toBeUndefined()
    expect(readFileSync(join(hermesHome, '.env'), 'utf-8')).toBe('')
  })
})
