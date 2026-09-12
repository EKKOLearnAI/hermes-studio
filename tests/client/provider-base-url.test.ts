import { describe, expect, it } from 'vitest'
import { inferApiKeyFunPresetProvider, isApiKeyFunBaseUrl } from '@/utils/providerBaseUrl'

describe('apikey.fan provider routing', () => {
  it('detects apikey.fan custom provider URLs without normalizing their path', () => {
    expect(isApiKeyFunBaseUrl('https://apikey.fan')).toBe(true)
    expect(isApiKeyFunBaseUrl('apikey.fan')).toBe(true)
    expect(isApiKeyFunBaseUrl('https://api.apikey.fan')).toBe(true)
    expect(isApiKeyFunBaseUrl('https://slb.apikey.fan/v1')).toBe(true)
    expect(isApiKeyFunBaseUrl('slb.apikey.fan/v1')).toBe(true)
    expect(isApiKeyFunBaseUrl('https://api.apikey.fan/')).toBe(true)
    expect(isApiKeyFunBaseUrl('https://api.apikey.fan/anything')).toBe(true)
    expect(isApiKeyFunBaseUrl('  https://api.apikey.fan/v2/chat  ')).toBe(true)
    expect(isApiKeyFunBaseUrl('https://not-api.apikey.fan/v1')).toBe(true)
  })

  it('does not match unrelated provider URLs', () => {
    expect(isApiKeyFunBaseUrl(' https://api.example.com/v1 ')).toBe(false)
    expect(isApiKeyFunBaseUrl('https://example.com/apikey.fan/v1')).toBe(false)
    expect(isApiKeyFunBaseUrl('https://apikey.fan.example.com/v1')).toBe(false)
    expect(isApiKeyFunBaseUrl('https://aistudio.google.com/apikey')).toBe(false)
  })

  it('routes apikey.fan models to the matching built-in provider key', () => {
    expect(inferApiKeyFunPresetProvider('claude-sonnet-4-6')).toBe('fun-claude')
    expect(inferApiKeyFunPresetProvider('gpt-5.5')).toBe('fun-codex')
    expect(inferApiKeyFunPresetProvider('gpt-5.3-codex')).toBe('fun-codex')
    expect(inferApiKeyFunPresetProvider('unknown-model')).toBeNull()
  })
})
