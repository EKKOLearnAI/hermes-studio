import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { saveGeminiOAuthTokensForProfile, status } from '../../packages/server/src/controllers/hermes/gemini-auth'

let hermesHome = ''

function writeFile(relativePath: string, content: string) {
  const target = join(hermesHome, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(join(hermesHome, relativePath), 'utf-8'))
}

function makeCtx(profile?: string): any {
  return {
    params: {},
    query: {},
    request: { body: {} },
    state: profile ? { profile: { name: profile } } : {},
    get: () => '',
    status: 200,
    body: undefined as unknown,
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

describe('Google Gemini CLI OAuth compatibility', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-gemini-oauth-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    vi.doUnmock('../../packages/server/src/services/app-config')
    vi.doUnmock('../../packages/server/src/services/hermes/copilot-models')
    delete process.env.HERMES_HOME
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('persists Google Gemini OAuth credentials in the request-scoped profile only', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })

    await saveGeminiOAuthTokensForProfile(
      'research',
      'research-access-token',
      'research-refresh-token',
      3600,
      'user@example.com',
      'project-123',
    )

    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
    expect(existsSync(join(hermesHome, 'auth', 'google_oauth.json'))).toBe(false)

    const googleAuth = readJson('profiles/research/auth/google_oauth.json')
    expect(googleAuth.access).toBe('research-access-token')
    expect(googleAuth.refresh).toBe('research-refresh-token|project-123|')
    expect(googleAuth.email).toBe('user@example.com')
    expect(typeof googleAuth.expires).toBe('number')

    const auth = readJson('profiles/research/auth.json')
    expect(auth.active_provider).toBe('google-gemini-cli')
    expect(auth.providers['google-gemini-cli'].tokens.access_token).toBe('research-access-token')
    expect(auth.credential_pool['google-gemini-cli'][0].refresh_token).toBe('research-refresh-token')
  })

  it('reports Google Gemini status from external google_oauth.json in the request-scoped profile', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research', 'auth'), { recursive: true })
    writeFile('auth/google_oauth.json', JSON.stringify({ access: 'default-token', refresh: 'default-refresh', expires: Date.now() + 3600_000 }, null, 2))
    writeFile('profiles/research/auth/google_oauth.json', JSON.stringify({ access: 'research-token', refresh: 'research-refresh', expires: Date.now() + 3600_000, email: 'research@example.com' }, null, 2))

    const ctx = makeCtx('research')
    await status(ctx)

    expect(ctx.body).toEqual({
      authenticated: true,
      last_refresh: undefined,
      email: 'research@example.com',
      expires_at_ms: expect.any(Number),
    })
  })

  it('lists Google Gemini OAuth models when only external google_oauth.json exists', async () => {
    writeFile('config.yaml', 'model:\n  default: gemini-3-flash-preview\n  provider: google-gemini-cli\n')
    writeFile('.env', '')
    writeFile('auth/google_oauth.json', JSON.stringify({ access: 'external-access-token', refresh: 'external-refresh-token', expires: Date.now() + 3600_000 }, null, 2))

    const { getAvailable } = await loadModelsController()
    const ctx = makeCtx()

    await getAvailable(ctx)

    expect(ctx.body.default_provider).toBe('google-gemini-cli')
    expect(ctx.body.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'google-gemini-cli',
          label: 'Google Gemini (OAuth)',
          base_url: 'cloudcode-pa://google',
          models: expect.arrayContaining(['gemini-3-flash-preview']),
        }),
      ]),
    )
  })
})
