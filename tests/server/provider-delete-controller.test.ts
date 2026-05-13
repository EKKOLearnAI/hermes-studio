import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

function makeCtx(poolKey: string) {
  return {
    params: { poolKey: encodeURIComponent(poolKey) },
    request: { body: {} },
    status: 200,
    body: undefined as unknown,
  }
}

function readAuth() {
  return JSON.parse(readFileSync(join(hermesHome, 'auth.json'), 'utf-8'))
}

describe('providers controller delete', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-provider-delete-'))
    mkdirSync(hermesHome, { recursive: true })
    writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: openai-codex\n  default: gpt-5.5\n')
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    vi.doUnmock('../../packages/server/src/controllers/hermes/providers')
    vi.clearAllMocks()
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('removes built-in API-key provider credentials from env and auth pool', async () => {
    writeFileSync(join(hermesHome, '.env'), [
      ['DEEPSEEK_API_KEY', 'deepseek-placeholder'].join('='),
      ['OPENROUTER_API_KEY', 'openrouter-placeholder'].join('='),
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      providers: {
        deepseek: { access_token: 'legacy-token' },
        openrouter: { access_token: 'keep-token' },
      },
      credential_pool: {
        deepseek: [{ label: 'DEEPSEEK_API_KEY', source: 'env:DEEPSEEK_API_KEY' }],
        openrouter: [{ label: 'OPENROUTER_API_KEY', source: 'env:OPENROUTER_API_KEY' }],
      },
    }, null, 2))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('deepseek')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const envAfter = readFileSync(join(hermesHome, '.env'), 'utf-8')
    expect(envAfter).not.toContain('DEEPSEEK_API_KEY')
    expect(envAfter).toContain(['OPENROUTER_API_KEY', 'openrouter-placeholder'].join('='))

    const authAfter = readAuth()
    expect(authAfter.providers).not.toHaveProperty('deepseek')
    expect(authAfter.credential_pool).not.toHaveProperty('deepseek')
    expect(authAfter.providers.openrouter).toEqual({ access_token: 'keep-token' })
    expect(authAfter.credential_pool.openrouter).toEqual([
      { label: 'OPENROUTER_API_KEY', source: 'env:OPENROUTER_API_KEY' },
    ])
  })

  it('removes custom provider config and any matching stored auth entry', async () => {
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'model:',
      '  provider: openai-codex',
      '  default: gpt-5.5',
      'custom_providers:',
      '  - name: deepseek-proxy',
      '    base_url: https://example.invalid/v1',
      '    api_key: placeholder',
      '    model: deepseek-chat',
      '  - name: keep-provider',
      '    base_url: https://keep.invalid/v1',
      '    api_key: placeholder',
      '    model: keep-model',
      '',
    ].join('\n'))
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      credential_pool: {
        'custom:deepseek-proxy': [{ label: 'custom' }],
        'custom:keep-provider': [{ label: 'keep' }],
      },
    }, null, 2))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('custom:deepseek-proxy')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const configAfter = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')
    expect(configAfter).not.toContain('deepseek-proxy')
    expect(configAfter).toContain('keep-provider')

    const authAfter = readAuth()
    expect(authAfter.credential_pool).not.toHaveProperty('custom:deepseek-proxy')
    expect(authAfter.credential_pool['custom:keep-provider']).toEqual([{ label: 'keep' }])
  })

  it('keeps OAuth-style provider deletion clearing stored auth entries', async () => {
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      providers: {
        'openai-codex': { account_id: 'remove-me' },
        copilot: { account_id: 'keep-me' },
      },
      credential_pool: {
        'openai-codex': [{ label: 'remove-me' }],
        copilot: [{ label: 'keep-me' }],
      },
    }, null, 2))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('openai-codex')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const authAfter = readAuth()
    expect(authAfter.providers).not.toHaveProperty('openai-codex')
    expect(authAfter.credential_pool).not.toHaveProperty('openai-codex')
    expect(authAfter.providers.copilot).toEqual({ account_id: 'keep-me' })
    expect(authAfter.credential_pool.copilot).toEqual([{ label: 'keep-me' }])
  })

  it('does not create auth.json when deleting a provider without stored auth credentials', async () => {
    writeFileSync(join(hermesHome, '.env'), [['DEEPSEEK_API_KEY', 'deepseek-placeholder'].join('='), ''].join('\n'))

    const { remove } = await loadProvidersController()
    const ctx = makeCtx('deepseek')

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
  })
})
