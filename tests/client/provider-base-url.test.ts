import { describe, expect, it } from 'vitest'
import { normalizeCustomProviderBaseUrl } from '@/utils/providerBaseUrl'

describe('normalizeCustomProviderBaseUrl', () => {
  it('normalizes api.apikey.fun custom provider URLs to the OpenAI-compatible v1 endpoint', () => {
    expect(normalizeCustomProviderBaseUrl('https://api.apikey.fun')).toBe('https://api.apikey.fun/v1')
    expect(normalizeCustomProviderBaseUrl('https://api.apikey.fun/')).toBe('https://api.apikey.fun/v1')
    expect(normalizeCustomProviderBaseUrl('https://api.apikey.fun/anything')).toBe('https://api.apikey.fun/v1')
    expect(normalizeCustomProviderBaseUrl('  https://api.apikey.fun/v2/chat  ')).toBe('https://api.apikey.fun/v1')
  })

  it('leaves unrelated provider URLs unchanged apart from trimming', () => {
    expect(normalizeCustomProviderBaseUrl(' https://api.example.com/v1 ')).toBe('https://api.example.com/v1')
    expect(normalizeCustomProviderBaseUrl('https://not-api.apikey.fun/v1')).toBe('https://not-api.apikey.fun/v1')
  })
})
