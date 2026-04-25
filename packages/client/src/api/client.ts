import router from '@/router'

const DEFAULT_BASE_URL = ''

function getBaseUrl(): string {
  return localStorage.getItem('hermes_server_url') || DEFAULT_BASE_URL
}

export function getApiKey(): string {
  return localStorage.getItem('hermes_api_key') || ''
}

export function setServerUrl(url: string) {
  localStorage.setItem('hermes_server_url', url)
}

export function setApiKey(key: string) {
  localStorage.setItem('hermes_api_key', key)
}

export function clearApiKey() {
  localStorage.removeItem('hermes_api_key')
}

export function hasApiKey(): boolean {
  return !!getApiKey()
}

/**
 * Get the effective base URL and API key.
 * If the active profile has a backend_url, route directly to that remote backend.
 * Otherwise, route through the local BFF.
 */
function getEffectiveConfig(): { baseUrl: string; apiKey: string } {
  const backendUrl = localStorage.getItem('hermes_profile_backend_url')
  const backendToken = localStorage.getItem('hermes_profile_backend_token')

  if (backendUrl) {
    return {
      baseUrl: backendUrl,
      apiKey: backendToken || getApiKey(),
    }
  }

  return {
    baseUrl: getBaseUrl(),
    apiKey: getApiKey(),
  }
}

export async function request<T>(path: string, options: RequestInit & { forceLocal?: boolean } = {}): Promise<T> {
  const { baseUrl: effectiveBaseUrl, apiKey: effectiveApiKey } = getEffectiveConfig()
  const baseUrl = options.forceLocal ? getBaseUrl() : effectiveBaseUrl
  const apiKey = options.forceLocal ? getApiKey() : effectiveApiKey
  const url = `${baseUrl}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // Inject active profile header for proxied gateway requests
  const profileName = localStorage.getItem('hermes_active_profile_name')
  if (profileName && profileName !== 'default') {
    headers['X-Hermes-Profile'] = profileName
  }

  const res = await fetch(url, { ...options, headers })

  // Global 401 handler — only redirect to login for local BFF endpoints
  // Proxied gateway requests should not trigger logout
  const isLocalBff = !path.startsWith('/api/hermes/v1/') &&
    !path.startsWith('/api/hermes/jobs') &&
    !path.startsWith('/api/hermes/skills')

  if (res.status === 401 && isLocalBff) {
    clearApiKey()
    if (router.currentRoute.value.name !== 'login') {
      router.replace({ name: 'login' })
    }
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API Error ${res.status}: ${text || res.statusText}`)
  }

  return res.json()
}

export function getBaseUrlValue(): string {
  return getBaseUrl()
}
