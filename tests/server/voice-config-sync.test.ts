import { describe, expect, it } from 'vitest'
import {
  applyHermesSttProvider,
  isUsableSecret,
  resolveHermesSttTarget,
} from '../../packages/server/src/services/hermes/voice-config-sync'

describe('resolveHermesSttTarget', () => {
  it('maps a Groq base URL to the groq provider and GROQ_API_KEY', () => {
    expect(resolveHermesSttTarget('https://api.groq.com/openai/v1')).toEqual({
      provider: 'groq',
      apiKeyEnv: 'GROQ_API_KEY',
    })
  })

  it('ignores hosts without an unambiguous Hermes provider', () => {
    expect(resolveHermesSttTarget('https://api.openai.com/v1')).toBeNull()
    expect(resolveHermesSttTarget('https://speech.example.com/v1')).toBeNull()
  })

  it('does not match a look-alike host', () => {
    expect(resolveHermesSttTarget('https://api.groq.com.evil.test/v1')).toBeNull()
  })

  it('returns null for empty or malformed input', () => {
    expect(resolveHermesSttTarget('')).toBeNull()
    expect(resolveHermesSttTarget('   ')).toBeNull()
    expect(resolveHermesSttTarget('not a url')).toBeNull()
    expect(resolveHermesSttTarget(undefined)).toBeNull()
    expect(resolveHermesSttTarget(42)).toBeNull()
  })
})

describe('isUsableSecret', () => {
  it('accepts a real key', () => {
    expect(isUsableSecret('gsk_live_key')).toBe(true)
  })

  it('rejects the stored-secret placeholder and blanks', () => {
    expect(isUsableSecret('[stored]')).toBe(false)
    expect(isUsableSecret('   ')).toBe(false)
    expect(isUsableSecret('')).toBe(false)
    expect(isUsableSecret(undefined)).toBe(false)
  })
})

describe('applyHermesSttProvider', () => {
  it('creates the stt block when missing', () => {
    const config: Record<string, any> = {}
    applyHermesSttProvider(config, 'groq')
    expect(config.stt).toEqual({ enabled: true, provider: 'groq' })
  })

  it('preserves unrelated stt keys written by the user', () => {
    const config: Record<string, any> = {
      stt: { provider: 'local', local: { model: 'base', language: 'ar' }, groq: { language: 'ar' } },
    }
    applyHermesSttProvider(config, 'groq')
    expect(config.stt.provider).toBe('groq')
    expect(config.stt.enabled).toBe(true)
    expect(config.stt.local).toEqual({ model: 'base', language: 'ar' })
    expect(config.stt.groq).toEqual({ language: 'ar' })
  })

  it('replaces a non-object stt value instead of throwing', () => {
    const config: Record<string, any> = { stt: 'local' }
    applyHermesSttProvider(config, 'groq')
    expect(config.stt).toEqual({ enabled: true, provider: 'groq' })
  })

  it('leaves the rest of the config untouched', () => {
    const config: Record<string, any> = { model: { default: 'glm-5.2:cloud' }, tts: { provider: 'edge' } }
    applyHermesSttProvider(config, 'groq')
    expect(config.model).toEqual({ default: 'glm-5.2:cloud' })
    expect(config.tts).toEqual({ provider: 'edge' })
  })
})
