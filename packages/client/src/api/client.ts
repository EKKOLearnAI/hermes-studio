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
 * Always routes through the local BFF — the BFF resolves the correct
 * upstream backend per profile (via X-Hermes-Profile header).
 * This prevents the browser from needing direct access to remote backends.
 */
function getEffectiveConfig(): { baseUrl: string; apiKey: string } {
  return {
    baseUrl: getBaseUrl(),
    apiKey: getApiKey(),
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { baseUrl, apiKey } = getEffectiveConfig()
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
