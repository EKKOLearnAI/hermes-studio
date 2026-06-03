import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

function writeAuthJson(auth: Record<string, unknown>, path = 'auth.json') {
  writeHermesFile(path, JSON.stringify(auth, null, 2))
}

function readAuthJson(path = 'auth.json') {
  return JSON.parse(readFileSync(join(hermesHome, path), 'utf-8'))
}

function makeCtx(profile?: string): any {
  return {
    params: {},
    query: {},
    request: { body: {} },
    state: profile ? { profile: { name: profile } } : {},
    get: () => '',
    body: undefined,
    status: 200,
  }
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
    process.env.CODEX_HOME = join(hermesHome, 'codex-home')
    writeConfigYaml('model:\n  default: gpt-5.5\n  provider: openai-codex\n')
    writeEnv('')
  })

  afterEach(() => {
    vi.doUnmock('../../packages/server/src/services/app-config')
    vi.doUnmock('../../packages/server/src/services/hermes/copilot-models')
    vi.doUnmock('../../packages/server/src/services/logger')
    delete process.env.HERMES_HOME
    delete process.env.CODEX_HOME
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

  it('reports Codex status from the request-scoped profile', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeAuthJson({ version: 1, providers: {}, credential_pool: {} })
    writeAuthJson({
      version: 1,
      providers: {},
      credential_pool: {
        'openai-codex': [
          { access_token: 'research-token', refresh_token: 'research-refresh', last_refresh: '2026-06-02T00:00:00.000Z' },
        ],
      },
    }, 'profiles/research/auth.json')

    const { status } = await loadCodexAuthController()
    const ctx = makeCtx('research')

    await status(ctx)

    expect(ctx.body).toEqual({ authenticated: true, last_refresh: '2026-06-02T00:00:00.000Z' })
  })

  it('persists Codex OAuth credentials in the request-scoped profile only', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })

    const { saveCodexOAuthTokensForProfile } = await loadCodexAuthController()
    saveCodexOAuthTokensForProfile('research', 'research-access-token', 'research-refresh-token')

    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
    const auth = readAuthJson('profiles/research/auth.json')
    expect(auth.providers['openai-codex'].tokens.access_token).toBe('research-access-token')
    expect(auth.credential_pool['openai-codex'][0].access_token).toBe('research-access-token')
  })
})
