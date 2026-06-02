import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let hermesHome = ''

function readAuthJson(path = 'auth.json') {
  return JSON.parse(readFileSync(join(hermesHome, path), 'utf-8'))
}

function makeCtx(profile: string): any {
  return {
    params: {},
    query: {},
    request: { body: {} },
    state: { profile: { name: profile } },
    get: () => '',
    body: undefined,
    status: 200,
  }
}

async function loadNousAuthController() {
  vi.resetModules()
  vi.doMock('../../packages/server/src/services/logger', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }))
  return import('../../packages/server/src/controllers/hermes/nous-auth')
}

describe('Nous auth controller', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-nous-auth-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    vi.doUnmock('../../packages/server/src/services/logger')
    delete process.env.HERMES_HOME
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('persists OAuth credentials in the request-scoped profile only', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })

    const { saveNousOAuthTokensForProfile } = await loadNousAuthController()
    saveNousOAuthTokensForProfile(
      'research',
      {
        access_token: 'research-access-token',
        refresh_token: 'research-refresh-token',
        expires_in: 3600,
        inference_base_url: 'https://inference-api.nousresearch.com/v1',
      },
      'research-agent-key',
      '2026-06-02T01:00:00.000Z',
    )

    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
    const auth = readAuthJson('profiles/research/auth.json')
    expect(auth.providers.nous.access_token).toBe('research-access-token')
    expect(auth.providers.nous.agent_key).toBe('research-agent-key')
    expect(auth.credential_pool.nous[0].refresh_token).toBe('research-refresh-token')
  })

  it('checks Nous auth status against the request-scoped profile', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })

    const { saveNousOAuthTokensForProfile, status } = await loadNousAuthController()
    saveNousOAuthTokensForProfile('research', {
      access_token: 'research-access-token',
      refresh_token: 'research-refresh-token',
    })

    const ctx = makeCtx('research')
    await status(ctx)

    expect(ctx.body).toEqual({ authenticated: true })
  })
})
