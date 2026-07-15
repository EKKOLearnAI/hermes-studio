import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let home = ''

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => profile === 'default' ? home : join(home, 'profiles', profile),
}))

describe('Ekko Agent authorized provider credentials', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ekko-agent-auth-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(home, { recursive: true, force: true })
  })

  it('resolves provider and pool credential shapes without exposing refresh tokens', async () => {
    await writeFile(join(home, 'auth.json'), JSON.stringify({
      providers: {
        nous: {
          agent_key: 'nous-invoke-jwt',
          access_token: 'nous-login-token',
          inference_base_url: 'https://inference-api.nousresearch.com/v1/',
        },
        'openai-codex': {
          tokens: { access_token: 'codex-access', refresh_token: 'codex-refresh' },
        },
      },
      credential_pool: {
        'xai-oauth': [{ access_token: 'xai-access', base_url: 'https://api.x.ai/v1' }],
        'qwen-oauth': [{ access_token: 'qwen-access', base_url: 'https://portal.qwen.ai/v1' }],
      },
    }))
    const { resolveEkkoAuthorizedProviderCredentials } = await import(
      '../../packages/server/src/services/ekko-agent/auth-providers'
    )

    await expect(resolveEkkoAuthorizedProviderCredentials('default', 'nous')).resolves.toEqual({
      apiKey: 'nous-invoke-jwt',
      baseUrl: 'https://inference-api.nousresearch.com/v1',
    })
    await expect(resolveEkkoAuthorizedProviderCredentials('default', 'openai-codex')).resolves.toEqual({
      apiKey: 'codex-access',
      baseUrl: undefined,
    })
    await expect(resolveEkkoAuthorizedProviderCredentials('default', 'xai-oauth')).resolves.toEqual({
      apiKey: 'xai-access',
      baseUrl: 'https://api.x.ai/v1',
    })
    await expect(resolveEkkoAuthorizedProviderCredentials('default', 'qwen-oauth')).resolves.toEqual({
      apiKey: 'qwen-access',
      baseUrl: 'https://portal.qwen.ai/v1',
    })
  })

  it('uses the requested profile and ignores non-auth providers', async () => {
    await mkdir(join(home, 'profiles', 'work'), { recursive: true })
    await writeFile(join(home, 'profiles', 'work', 'auth.json'), JSON.stringify({
      providers: { 'openai-codex': { access_token: 'work-token' } },
    }))
    const { resolveEkkoAuthorizedProviderCredentials } = await import(
      '../../packages/server/src/services/ekko-agent/auth-providers'
    )

    await expect(resolveEkkoAuthorizedProviderCredentials('work', 'openai-codex')).resolves.toEqual({
      apiKey: 'work-token',
      baseUrl: undefined,
    })
    await expect(resolveEkkoAuthorizedProviderCredentials('work', 'deepseek')).resolves.toEqual({})
  })

})
