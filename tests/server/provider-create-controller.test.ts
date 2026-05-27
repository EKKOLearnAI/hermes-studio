import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
})
