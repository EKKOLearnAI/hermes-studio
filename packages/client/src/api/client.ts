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

export type StoredUserRole = 'super_admin' | 'admin'

export function getStoredUserRole(): StoredUserRole | null {
  const token = getApiKey()
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const data = JSON.parse(atob(padded)) as { role?: unknown }
    return data.role === 'super_admin' || data.role === 'admin' ? data.role : null
  } catch {
    return null
  }
}

export function isStoredSuperAdmin(): boolean {
  return getStoredUserRole() === 'super_admin'
}

export function getActiveProfileName(): string | null {
  return localStorage.getItem('hermes_active_profile_name')
}

function bodyHasProfileSelector(body: BodyInit | null | undefined): boolean {
  if (typeof body !== 'string') return false
  try {
    const parsed = JSON.parse(body) as { profile?: unknown }
    return typeof parsed?.profile === 'string' && parsed.profile.trim().length > 0
  } catch {
    return false
  }
}

function shouldAttachProfileHeader(path: string, options: RequestInit): boolean {
  try {
    const url = new URL(path, 'http://hermes.local')
    if (url.searchParams.has('profile')) return false
    if (url.pathname.startsWith('/api/hermes/profiles')) return false
    if (isProfileWideSessionCollection(url.pathname)) return false
  } catch {
    if (path.startsWith('/api/hermes/profiles')) return false
    if (isProfileWideSessionCollection(path.split('?')[0] || path)) return false
  }
  return !bodyHasProfileSelector(options.body)
}

function isProfileWideSessionCollection(pathname: string): boolean {
  return pathname === '/api/hermes/sessions' ||
    pathname === '/api/hermes/search/sessions' ||
    pathname === '/api/hermes/sessions/search' ||
    pathname === '/api/hermes/sessions/conversations'
}

function emitAuthNotice(kind: 'expired' | 'forbidden') {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('hermes-auth-notice', { detail: { kind } }))
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = getBaseUrl()
  const url = `${base}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  }

  const apiKey = getApiKey()
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // Inject active profile header for request-scoped endpoints. Explicit profile
  // selectors in the URL/body and profile-name routes are validated directly.
  const profileName = getActiveProfileName()
  if (profileName && shouldAttachProfileHeader(path, options)) {
    headers['X-Hermes-Profile'] = profileName
  }

  const res = await fetch(url, { ...options, headers })

  // Global 401 handler — only redirect to login for local BFF endpoints
  // Proxied gateway requests should not trigger logout
  const isLocalBff = !path.startsWith('/api/hermes/v1/') &&
    !path.startsWith('/v1/')

  if (res.status === 401 && isLocalBff) {
    clearApiKey()
    emitAuthNotice('expired')
    if (router.currentRoute.value.name !== 'login') {
      router.replace({ name: 'login' })
    }
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 403 && isLocalBff) {
      if (text.includes('User is disabled or does not exist')) {
        clearApiKey()
        emitAuthNotice('expired')
        if (router.currentRoute.value.name !== 'login') {
          router.replace({ name: 'login' })
        }
      } else {
        emitAuthNotice('forbidden')
      }
    }
    throw new Error(`API Error ${res.status}: ${text || res.statusText}`)
  }

  return res.json()
}

export function getBaseUrlValue(): string {
  return getBaseUrl()
}
