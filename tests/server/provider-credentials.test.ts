import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  canonicalProviderIdentity,
  projectProviderConfigForResponse,
  resolveStoredProviderRuntime,
} from '../../packages/server/src/services/hermes/provider-credentials'

let hermesHome = ''

function writeProfile(profile: string, config: string, env = ''): void {
  const dir = profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), config)
  writeFileSync(join(dir, '.env'), env)
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'hwui-provider-credentials-'))
  process.env.HERMES_HOME = hermesHome

  writeProfile('default', [
    'model:',
    '  provider: deepseek',
    '  default: deepseek-chat',
    'custom_providers:',
    '  - name: deepseek',
    '    base_url: https://custom-deepseek.invalid/v1',
    '    api_key: custom-inline-value',
    '    model: custom-model',
    '    api_mode: codex_responses',
    '  - name: env-proxy',
    '    base_url: https://env-proxy.invalid/v1',
    '    key_env: CUSTOM_PROXY_KEY',
    '    model: env-model',
    '  - name: legacy-env',
    '    base_url: https://legacy-env.invalid/v1',
    '    api_key_env: LEGACY_PROXY_KEY',
    '    model: legacy-model',
    'providers:',
    '  dict-proxy:',
    '    name: dict-proxy',
    '    base_url: https://dict-proxy.invalid/v1',
    '    key_env: DICT_PROXY_KEY',
    '    model: dict-model',
    '',
  ].join('\n'), [
    'DEEPSEEK_API_KEY=default-builtin-value',
    'CUSTOM_PROXY_KEY=default-custom-env-value',
    'LEGACY_PROXY_KEY=default-legacy-env-value',
    'DICT_PROXY_KEY=default-dict-env-value',
    '',
  ].join('\n'))

  writeProfile('research', [
    'model:',
    '  provider: custom:deepseek',
    '  default: research-model',
    'custom_providers:',
    '  - name: deepseek',
    '    base_url: https://research-deepseek.invalid/v1',
    '    key_env: RESEARCH_CUSTOM_KEY',
    '    model: research-model',
    '',
  ].join('\n'), [
    'DEEPSEEK_API_KEY=research-builtin-value',
    'RESEARCH_CUSTOM_KEY=research-custom-value',
    '',
  ].join('\n'))
})

afterEach(() => {
  delete process.env.HERMES_HOME
  if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  hermesHome = ''
})

describe('canonical provider identity', () => {
  it('keeps bare built-ins isolated from same-named custom providers', () => {
    expect(canonicalProviderIdentity('deepseek')).toEqual({
      kind: 'builtin',
      poolKey: 'deepseek',
      lookupKey: 'deepseek',
    })
    expect(canonicalProviderIdentity('custom:deepseek')).toEqual({
      kind: 'custom',
      poolKey: 'custom:deepseek',
      lookupKey: 'deepseek',
    })
    expect(canonicalProviderIdentity('custom_deepseek')).toEqual({
      kind: 'custom',
      poolKey: 'custom:deepseek',
      lookupKey: 'deepseek',
    })
  })

  it.each(['', '   ', 'custom:', 'custom_', 'custom:deep seek'])('rejects invalid pool key %j', (poolKey) => {
    expect(() => canonicalProviderIdentity(poolKey)).toThrow(expect.objectContaining({ status: 400 }))
  })
})

describe('stored provider runtime resolution', () => {
  it('resolves builtin credentials only from the builtin env mapping', async () => {
    const runtime = await resolveStoredProviderRuntime({ profile: 'default', poolKey: 'deepseek' })

    expect(runtime).toMatchObject({
      identity: { kind: 'builtin', poolKey: 'deepseek', lookupKey: 'deepseek' },
      baseUrl: 'https://api.deepseek.com',
      apiMode: 'chat_completions',
      hasApiKey: true,
      apiKey: 'default-builtin-value',
      credentialSource: { kind: 'builtin-env', envKey: 'DEEPSEEK_API_KEY' },
    })
    expect(JSON.stringify(runtime)).not.toContain('custom-inline-value')
  })

  it('resolves explicit custom inline credentials without consuming builtin state', async () => {
    const runtime = await resolveStoredProviderRuntime({ profile: 'default', poolKey: 'custom:deepseek' })

    expect(runtime).toMatchObject({
      identity: { kind: 'custom', poolKey: 'custom:deepseek', lookupKey: 'deepseek' },
      baseUrl: 'https://custom-deepseek.invalid/v1',
      apiMode: 'codex_responses',
      hasApiKey: true,
      apiKey: 'custom-inline-value',
      credentialSource: { kind: 'custom-inline', providerSource: 'custom_providers' },
    })
    expect(JSON.stringify(runtime)).not.toContain('default-builtin-value')
  })

  it.each([
    ['custom:env-proxy', 'default-custom-env-value', 'CUSTOM_PROXY_KEY', 'custom_providers', undefined],
    ['custom:legacy-env', 'default-legacy-env-value', 'LEGACY_PROXY_KEY', 'custom_providers', undefined],
    ['custom:dict-proxy', 'default-dict-env-value', 'DICT_PROXY_KEY', 'providers', 'dict-proxy'],
  ] as const)('resolves env-backed custom provider %s', async (poolKey, value, envKey, providerSource, providerKey) => {
    const runtime = await resolveStoredProviderRuntime({ profile: 'default', poolKey })

    expect(runtime.hasApiKey).toBe(true)
    expect(runtime.apiKey).toBe(value)
    expect(runtime.credentialSource).toEqual({
      kind: 'custom-env',
      envKey,
      providerSource,
      ...(providerKey ? { providerKey } : {}),
    })
  })

  it('reads only the request-scoped profile config and env', async () => {
    const builtin = await resolveStoredProviderRuntime({ profile: 'research', poolKey: 'deepseek' })
    const custom = await resolveStoredProviderRuntime({ profile: 'research', poolKey: 'custom:deepseek' })

    expect(builtin.apiKey).toBe('research-builtin-value')
    expect(custom.apiKey).toBe('research-custom-value')
    expect(custom.baseUrl).toBe('https://research-deepseek.invalid/v1')
    expect(JSON.stringify([builtin, custom])).not.toContain('default-builtin-value')
    expect(JSON.stringify([builtin, custom])).not.toContain('custom-inline-value')
  })

  it('does not fall back to the default profile for a missing profile directory', async () => {
    const runtime = await resolveStoredProviderRuntime({ profile: 'missing-profile', poolKey: 'deepseek' })
    expect(runtime.hasApiKey).toBe(false)
    expect(runtime.apiKey).toBe('')
  })
})

describe('provider config projection', () => {
  it('recursively redacts inline secrets and reports inline/env credential presence', async () => {
    const runtimeConfig = {
      model: {
        provider: 'custom:inline',
        default: 'inline-model',
        api_key: 'legacy-model-value',
      },
      custom_providers: [
        {
          name: 'inline',
          base_url: 'https://inline.invalid/v1',
          api_key: 'nested-inline-value',
          extra_body: {
            api_key: 'nested-extra-value',
            auth: 'auth-alias-value',
            authentication: 'authentication-alias-value',
            token_value: 'token-alias-value',
            bearer_token_value: 'bearer-token-alias-value',
            client_secret_token_url: 'compound-secret-metadata-value',
            credential_token_url: 'compound-credential-metadata-value',
            connection_string_token_url: 'compound-connection-metadata-value',
            cookie_token_url: 'compound-cookie-metadata-value',
            authorization_url: 'https://idp.invalid/authorize',
            authorization_endpoint: 'https://idp.invalid/authorize-endpoint',
            token_method: 'authorization-code',
            tokenMethod: 'client-credentials',
            headers: {
              'x-api-key': 'header-key-value',
              authorization: 'header-auth-value',
              'Proxy-Authorization': 'proxy-auth-value',
            },
            client_secret: 'client-secret-value',
            secret_access_key: 'secret-access-key-value',
            private_key: 'private-key-value',
            refresh_token: 'refresh-token-value',
            password: 'password-value',
            connection_string: 'connection-string-value',
          },
        },
        {
          name: 'env-proxy',
          base_url: 'https://env-proxy.invalid/v1',
          key_env: 'CUSTOM_PROXY_KEY',
        },
        {
          name: 'missing-env',
          base_url: 'https://missing.invalid/v1',
          key_env: 'MISSING_KEY',
        },
      ],
      providers: {
        dict: {
          base_url: 'https://dict.invalid/v1',
          apiKey: 'dict-inline-value',
        },
      },
    }

    const projected = await projectProviderConfigForResponse(runtimeConfig, { profile: 'default' })
    const serialized = JSON.stringify(projected)

    expect(projected.model).toMatchObject({ api_key: '', has_api_key: true })
    expect(projected.custom_providers[0]).toMatchObject({ api_key: '', has_api_key: true })
    expect(projected.custom_providers[0].extra_body).toEqual({
      api_key: '',
      auth: '',
      authentication: '',
      token_value: '',
      bearer_token_value: '',
      client_secret_token_url: '',
      credential_token_url: '',
      connection_string_token_url: '',
      cookie_token_url: '',
      authorization_url: 'https://idp.invalid/authorize',
      authorization_endpoint: 'https://idp.invalid/authorize-endpoint',
      token_method: 'authorization-code',
      tokenMethod: 'client-credentials',
      headers: { 'x-api-key': '', authorization: '', 'Proxy-Authorization': '' },
      client_secret: '',
      secret_access_key: '',
      private_key: '',
      refresh_token: '',
      password: '',
      connection_string: '',
    })
    expect(projected.custom_providers[1]).toMatchObject({ api_key: '', has_api_key: true })
    expect(projected.custom_providers[2]).toMatchObject({ api_key: '', has_api_key: false })
    expect(projected.providers.dict).toMatchObject({ api_key: '', apiKey: '', has_api_key: true })
    for (const forbidden of [
      'nested-inline-value',
      'nested-extra-value',
      'auth-alias-value',
      'authentication-alias-value',
      'token-alias-value',
      'bearer-token-alias-value',
      'compound-secret-metadata-value',
      'compound-credential-metadata-value',
      'compound-connection-metadata-value',
      'compound-cookie-metadata-value',
      'dict-inline-value',
      'default-custom-env-value',
      'legacy-model-value',
      'header-key-value',
      'header-auth-value',
      'proxy-auth-value',
      'client-secret-value',
      'secret-access-key-value',
      'private-key-value',
      'refresh-token-value',
      'password-value',
      'connection-string-value',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('redacts provider sections even when their parsed shapes are malformed', async () => {
    const malformedConfig = {
      model: [{ api_key: 'model-array-value' }],
      custom_providers: {
        malformed: { token_value: 'custom-object-value' },
      },
      providers: {
        api_key: 'providers-entry-value',
        base_url: 'https://malformed-provider.invalid/v1',
      },
    }

    const projected = await projectProviderConfigForResponse(malformedConfig, {
      profile: 'default',
      envContent: '',
    })
    const serialized = JSON.stringify(projected)

    expect(projected.model).toEqual([{ api_key: '' }])
    expect(projected.custom_providers).toEqual({ malformed: { token_value: '' } })
    expect(projected.providers).toEqual({
      api_key: '',
      base_url: 'https://malformed-provider.invalid/v1',
    })
    for (const forbidden of ['model-array-value', 'custom-object-value', 'providers-entry-value']) {
      expect(serialized).not.toContain(forbidden)
    }

    const nestedEntryShape = await projectProviderConfigForResponse({
      providers: {
        api_key: { value: 'nested-providers-entry-value' },
        base_url: { value: 'https://nested-malformed-provider.invalid/v1' },
      },
    }, {
      profile: 'default',
      envContent: '',
    })
    expect(nestedEntryShape.providers).toEqual({
      api_key: '',
      base_url: { value: 'https://nested-malformed-provider.invalid/v1' },
    })
    expect(JSON.stringify(nestedEntryShape)).not.toContain('nested-providers-entry-value')
  })

  it('blanks unkeyed scalar values in malformed provider sections', async () => {
    const projected = await projectProviderConfigForResponse({
      model: 'model-scalar-value',
      custom_providers: ['custom-scalar-value'],
      providers: 'providers-scalar-value',
    }, {
      profile: 'default',
      envContent: '',
    })

    expect(projected).toMatchObject({
      model: '',
      custom_providers: [''],
      providers: '',
    })
    const serialized = JSON.stringify(projected)
    for (const forbidden of ['model-scalar-value', 'custom-scalar-value', 'providers-scalar-value']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
