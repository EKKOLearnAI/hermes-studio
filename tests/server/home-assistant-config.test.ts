import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HomeAssistantConfigError,
  publicHomeAssistantConfig,
  resolveHomeAssistantConfig,
  resolveHomeAssistantConfigMaterial,
} from '../../packages/server/src/services/hermes/home/home-assistant-config'

describe('home assistant configuration', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const homes: string[] = []

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('resolves a local endpoint, bounded defaults, env credential precedence, and a safe public view', () => {
    const resolved = resolveHomeAssistantConfigMaterial('home', {
      home_assistant: {
        base_url: 'http://homeassistant.local:8123/',
        token: 'config-token-must-not-win',
        token_env: 'HOME_ASSISTANT_TOKEN',
      },
    }, { HOME_ASSISTANT_TOKEN: 'profile-env-long-lived-access-token' })

    expect(resolved).toMatchObject({
      profile: 'home', baseUrl: 'http://homeassistant.local:8123',
      restStatesUrl: 'http://homeassistant.local:8123/api/states',
      websocketUrl: 'ws://homeassistant.local:8123/api/websocket',
      token: 'profile-env-long-lived-access-token', connectTimeoutMs: 10_000,
      requestTimeoutMs: 15_000, heartbeatIntervalMs: 30_000,
      reconnectInitialMs: 1_000, reconnectMaxMs: 30_000,
      maxWebSocketMessageBytes: 1_048_576, maxRestResponseBytes: 8_388_608,
      tlsVerify: true,
    })
    expect(resolved?.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const safe = publicHomeAssistantConfig(resolved!)
    expect(safe).toMatchObject({ profile: 'home', configured: true, tokenConfigured: true })
    expect(JSON.stringify(safe)).not.toContain('profile-env-long-lived-access-token')
    expect(JSON.stringify(safe)).not.toContain('config-token-must-not-win')
  })

  it.each([
    ['remote plaintext', { base_url: 'http://ha.example.com:8123', token: 'long-enough-home-assistant-token' }],
    ['embedded credentials', { base_url: 'https://user:pass@ha.example.com', token: 'long-enough-home-assistant-token' }],
    ['base path', { base_url: 'https://ha.example.com/proxy', token: 'long-enough-home-assistant-token' }],
    ['query', { base_url: 'https://ha.example.com?token=bad', token: 'long-enough-home-assistant-token' }],
    ['disabled TLS verification', {
      base_url: 'https://ha.example.com', token: 'long-enough-home-assistant-token', tls_verify: false,
    }],
    ['unbounded timeout', {
      base_url: 'https://ha.example.com', token: 'long-enough-home-assistant-token', request_timeout_ms: 600_001,
    }],
    ['unknown key', {
      base_url: 'https://ha.example.com', token: 'long-enough-home-assistant-token', access_token: 'shadow-secret',
    }],
  ])('rejects unsafe material: %s', (_name, homeAssistant) => {
    expect(() => resolveHomeAssistantConfigMaterial('home', { home_assistant: homeAssistant }, {}))
      .toThrow(HomeAssistantConfigError)
  })

  it('returns null when unconfigured or explicitly disabled and rejects missing credentials', () => {
    expect(resolveHomeAssistantConfigMaterial('home', {}, {})).toBeNull()
    expect(resolveHomeAssistantConfigMaterial('home', {
      home_assistant: { enabled: false, base_url: 'https://ha.example.com' },
    }, {})).toBeNull()
    expect(() => resolveHomeAssistantConfigMaterial('home', {
      home_assistant: { base_url: 'https://ha.example.com' },
    }, {})).toThrow(/token/i)
  })

  it('loads credentials only from the exact named profile', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-home-assistant-config-'))
    homes.push(hermesHome)
    process.env.HERMES_HOME = hermesHome
    writeFileSync(join(hermesHome, '.env'), 'HOME_ASSISTANT_TOKEN=default-profile-secret-token\n')
    writeFileSync(join(hermesHome, 'config.yaml'), 'home_assistant:\n  base_url: https://default.example.test\n')
    const named = join(hermesHome, 'profiles', 'home')
    mkdirSync(named, { recursive: true })
    writeFileSync(join(named, '.env'), 'HOME_ASSISTANT_TOKEN=named-profile-secret-token\n')
    writeFileSync(join(named, 'config.yaml'), 'home_assistant:\n  base_url: https://named.example.test\n')

    const resolved = await resolveHomeAssistantConfig('home')
    expect(resolved).toMatchObject({
      profile: 'home', baseUrl: 'https://named.example.test', token: 'named-profile-secret-token',
    })
    await expect(resolveHomeAssistantConfig('missing')).rejects.toMatchObject({
      code: 'HOME_ASSISTANT_PROFILE_NOT_FOUND',
    })
  })
})
