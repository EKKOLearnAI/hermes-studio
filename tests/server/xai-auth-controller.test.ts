import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'
import { applyXaiOAuthDefaultModel, saveXaiOAuthTokensForProfile, status } from '../../packages/server/src/controllers/hermes/xai-auth'

let hermesHome = ''

function writeFile(relativePath: string, content: string) {
  const target = join(hermesHome, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function readYaml(relativePath: string) {
  return YAML.load(readFileSync(join(hermesHome, relativePath), 'utf-8')) as any
}

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(join(hermesHome, relativePath), 'utf-8'))
}

function makeCtx(profile: string): any {
  return {
    state: { profile: { name: profile } },
    query: {},
    request: { body: {} },
    get: () => '',
    status: 200,
    body: undefined as unknown,
  }
}

describe('xAI auth controller', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-xai-auth-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('does not keep a non-xAI model when switching the default provider to xai-oauth', () => {
    const config = applyXaiOAuthDefaultModel({
      model: {
        default: 'glm-5-turbo',
        provider: 'custom:glm-coding-plan',
        base_url: 'https://api.z.ai/api/anthropic',
        api_key: 'secret',
      },
    })

    expect(config.model).toEqual({
      default: 'grok-4.3',
      provider: 'xai-oauth',
    })
  })

  it('preserves an existing Grok model when refreshing xai-oauth credentials', () => {
    const config = applyXaiOAuthDefaultModel({
      model: {
        default: 'grok-4.20-reasoning',
        provider: 'xai-oauth',
      },
    })

    expect(config.model).toEqual({
      default: 'grok-4.20-reasoning',
      provider: 'xai-oauth',
    })
  })

  it('persists OAuth credentials and default model in the request-scoped profile only', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeFile('config.yaml', 'model:\n  provider: deepseek\n  default: deepseek-chat\n')
    writeFile('profiles/research/config.yaml', 'model:\n  provider: openrouter\n  default: openrouter-model\n')

    await saveXaiOAuthTokensForProfile(
      'research',
      {
        discovery: { token_endpoint: 'https://auth.x.ai/oauth/token' },
        redirectUri: 'http://127.0.0.1:56121/callback',
      },
      {
        access_token: 'research-access-token',
        refresh_token: 'research-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    )

    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
    const auth = readJson('profiles/research/auth.json')
    expect(auth.providers['xai-oauth'].tokens.access_token).toBe('research-access-token')
    expect(auth.credential_pool['xai-oauth'][0].refresh_token).toBe('research-refresh-token')

    expect(readYaml('config.yaml').model).toEqual({ provider: 'deepseek', default: 'deepseek-chat' })
    expect(readYaml('profiles/research/config.yaml').model).toEqual({ provider: 'xai-oauth', default: 'grok-4.3' })
  })

  it('checks xAI OAuth status against the request-scoped profile', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeFile('auth.json', JSON.stringify({ version: 1, providers: {}, credential_pool: {} }, null, 2))
    writeFile('profiles/research/auth.json', JSON.stringify({
      version: 1,
      providers: {
        'xai-oauth': {
          last_refresh: '2026-06-02T00:00:00.000Z',
          tokens: { access_token: 'research-access-token' },
        },
      },
    }, null, 2))

    const ctx = makeCtx('research')
    await status(ctx)

    expect(ctx.body).toEqual({ authenticated: true, last_refresh: '2026-06-02T00:00:00.000Z' })
  })
})
