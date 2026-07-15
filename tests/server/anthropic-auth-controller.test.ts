import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'
import {
  applyAnthropicOAuthDefaultModel,
  saveAnthropicOAuthTokensForProfile,
  status as anthropicStatus,
} from '../../packages/server/src/controllers/hermes/anthropic-auth'

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

describe('Anthropic OAuth controller', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-oauth-provider-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('uses a provider-compatible default model when applying OAuth defaults', () => {
    expect(applyAnthropicOAuthDefaultModel({
      model: { provider: 'deepseek', default: 'deepseek-chat', base_url: 'x', api_key: 'y' },
    }).model).toEqual({ provider: 'claude-oauth', default: 'claude-sonnet-4-6' })
  })

  it('persists OAuth credentials in the request-scoped profile only', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeFile('config.yaml', 'model:\n  provider: deepseek\n  default: deepseek-chat\n')
    writeFile('profiles/research/config.yaml', 'model:\n  provider: openrouter\n  default: openrouter-model\n')

    await saveAnthropicOAuthTokensForProfile('research', {
      access_token: 'anthropic-access-token',
      refresh_token: 'anthropic-refresh-token',
      expires_in: 3600,
    })

    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
    const auth = readJson('profiles/research/auth.json')
    expect(auth.providers['claude-oauth'].tokens.access_token).toBe('anthropic-access-token')
    expect(auth.credential_pool['claude-oauth'][0].refresh_token).toBe('anthropic-refresh-token')
    expect(auth.providers.anthropic.tokens.access_token).toBe('anthropic-access-token')
    expect(auth.credential_pool.anthropic[0].refresh_token).toBe('anthropic-refresh-token')
    expect(readJson('profiles/research/.anthropic_oauth.json').accessToken).toBe('anthropic-access-token')
    expect(readYaml('config.yaml').model).toEqual({ provider: 'deepseek', default: 'deepseek-chat' })
    expect(readYaml('profiles/research/config.yaml').model).toEqual({ provider: 'claude-oauth', default: 'claude-sonnet-4-6' })

    const ctx = makeCtx('research')
    await anthropicStatus(ctx)
    expect(ctx.body).toMatchObject({ authenticated: true })
  })
})
