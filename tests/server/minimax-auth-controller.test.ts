import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import YAML from 'js-yaml'

let hermesHome = ''

function makeCtx(body: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    request: { body },
    state: { profile: { name: 'default' } },
    get: () => '',
    status: 200,
    body: undefined,
  }
}

describe('MiniMax Coding Plan OAuth controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-minimax-auth-'))
    process.env.HERMES_HOME = hermesHome
    writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: deepseek\n  default: deepseek-chat\n')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete process.env.HERMES_HOME
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('persists the upstream-compatible auth state after the user-code flow', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const state = new URLSearchParams(String(init.body)).get('state')
        return {
          ok: true,
          json: async () => ({
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://www.minimax.io/oauth/activate',
            expired_in: 900,
            interval: 2000,
            state,
          }),
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          access_token: 'minimax-access',
          refresh_token: 'minimax-refresh',
          expired_in: 3600,
          token_type: 'Bearer',
          resource_url: 'https://api.minimax.io',
        }),
      })
    vi.stubGlobal('fetch', fetchMock)
    await import('../../packages/server/src/bootstrap/agent-profile-adapter')
    const { start, poll } = await import(
      '../../packages/server/src/modules/hermes/controllers/minimax-auth'
    )

    const startCtx = makeCtx({ region: 'global' })
    await start(startCtx)
    expect(startCtx.body).toMatchObject({
      user_code: 'ABCD-EFGH',
      verification_url: 'https://www.minimax.io/oauth/activate',
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(async () => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(readFileSync(join(hermesHome, 'auth.json'), 'utf8')).toContain('minimax-access')
      const statusCtx = makeCtx()
      statusCtx.params.sessionId = startCtx.body.session_id
      await poll(statusCtx)
      expect(statusCtx.body).toEqual({ status: 'approved', error: null })
    })
    const pollCtx = makeCtx()
    pollCtx.params.sessionId = startCtx.body.session_id
    await poll(pollCtx)
    expect(pollCtx.body).toEqual({ status: 'approved', error: null })

    const auth = JSON.parse(readFileSync(join(hermesHome, 'auth.json'), 'utf8'))
    expect(auth.providers['minimax-oauth']).toMatchObject({
      provider: 'minimax-oauth',
      region: 'global',
      portal_base_url: 'https://api.minimax.io',
      inference_base_url: 'https://api.minimax.io/anthropic',
      client_id: '78257093-7e40-4613-99e0-527b14b39113',
      scope: 'group_id profile model.completion',
      access_token: 'minimax-access',
      refresh_token: 'minimax-refresh',
    })
    expect(auth.active_provider).toBe('minimax-oauth')
    expect(auth.credential_pool?.['minimax-oauth']).toBeUndefined()
    const config = YAML.load(readFileSync(join(hermesHome, 'config.yaml'), 'utf8')) as any
    expect(config.model).toEqual({
      provider: 'minimax-oauth',
      default: 'MiniMax-M3',
    })
  })

  it('keeps a selected MiniMax model when applying the OAuth provider', async () => {
    const { applyMiniMaxOAuthDefaultModel } = await import(
      '../../packages/server/src/modules/hermes/controllers/minimax-auth'
    )
    expect(applyMiniMaxOAuthDefaultModel({
      model: {
        provider: 'minimax',
        default: 'MiniMax-M2.7-highspeed',
        base_url: 'https://old.example',
        api_key: 'old-key',
      },
    }).model).toEqual({
      provider: 'minimax-oauth',
      default: 'MiniMax-M2.7-highspeed',
    })
  })
})
