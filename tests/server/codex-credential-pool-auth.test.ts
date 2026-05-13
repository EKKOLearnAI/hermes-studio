import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let hermesHome = ''

function writeHermesFile(path: string, content: string) {
  mkdirSync(hermesHome, { recursive: true })
  writeFileSync(join(hermesHome, path), content)
}

function writeConfigYaml(content: string) {
  writeHermesFile('config.yaml', content)
}

function writeEnv(content = '') {
  writeHermesFile('.env', content)
}

function writeAuthJson(auth: Record<string, unknown>) {
  writeHermesFile('auth.json', JSON.stringify(auth, null, 2))
}

function makeCtx(): any {
  return { params: {}, request: { body: {} }, body: undefined, status: 200 }
}

async function loadModelsController() {
  vi.resetModules()
  vi.doMock('../../packages/server/src/services/app-config', () => ({
    readAppConfig: vi.fn().mockResolvedValue({}),
  }))
  vi.doMock('../../packages/server/src/services/hermes/copilot-models', () => ({
    getCopilotModelsDetailed: vi.fn().mockResolvedValue([]),
    resolveCopilotOAuthToken: vi.fn().mockResolvedValue(''),
  }))
  return import('../../packages/server/src/controllers/hermes/models')
}

async function loadCodexAuthController() {
  vi.resetModules()
  vi.doMock('../../packages/server/src/services/logger', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }))
  return import('../../packages/server/src/controllers/hermes/codex-auth')
}

describe('OpenAI Codex credential pool auth compatibility', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-codex-pool-'))
    process.env.HERMES_HOME = hermesHome
    writeConfigYaml('model:\n  default: gpt-5.5\n  provider: openai-codex\n')
    writeEnv('')
  })

  afterEach(() => {
    vi.doUnmock('../../packages/server/src/services/app-config')
    vi.doUnmock('../../packages/server/src/services/hermes/copilot-models')
    vi.doUnmock('../../packages/server/src/services/logger')
    delete process.env.HERMES_HOME
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('lists OpenAI Codex models when auth.json only has credential_pool entries', async () => {
    writeAuthJson({
      version: 1,
      providers: {},
      active_provider: 'openai-codex',
      credential_pool: {
        'openai-codex': [
          { id: 'main', auth_type: 'oauth', access_token: 'access-token-from-pool', refresh_token: 'refresh-token-from-pool' },
        ],
      },
    })

    const { getAvailable } = await loadModelsController()
    const ctx = makeCtx()

    await getAvailable(ctx)

    expect(ctx.body.default).toBe('gpt-5.5')
    expect(ctx.body.default_provider).toBe('openai-codex')
    expect(ctx.body.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'openai-codex',
          label: 'OpenAI Codex',
          models: expect.arrayContaining(['gpt-5.5', 'gpt-5.4-mini']),
        }),
      ]),
    )
  })

  it('reports Codex authenticated from credential_pool without requiring legacy providers tokens', async () => {
    writeAuthJson({
      version: 1,
      providers: {},
      active_provider: 'openai-codex',
      credential_pool: {
        'openai-codex': [
          { id: 'main', auth_type: 'oauth', access_token: 'non-jwt-access-token', refresh_token: 'refresh-token-from-pool', last_refresh: '2026-05-10T00:00:00.000Z' },
        ],
      },
    })

    const { status } = await loadCodexAuthController()
    const ctx = makeCtx()

    await status(ctx)

    expect(ctx.body).toEqual({ authenticated: true, last_refresh: '2026-05-10T00:00:00.000Z' })
  })
})
