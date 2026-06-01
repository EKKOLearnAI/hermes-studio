const APIKEY_FUN_BASE_URL = 'https://api.apikey.fun/v1'

export function normalizeCustomProviderBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim()
  if (!value) return value

  try {
    const parsed = new URL(value)
    if (parsed.hostname.toLowerCase() === 'api.apikey.fun') return APIKEY_FUN_BASE_URL
  } catch {
    // Fall back to a string match so partially typed values still normalize on submit.
    if (/^https:\/\/api\.apikey\.fun(?:\/|$)/i.test(value)) return APIKEY_FUN_BASE_URL
  }

  return value
}
