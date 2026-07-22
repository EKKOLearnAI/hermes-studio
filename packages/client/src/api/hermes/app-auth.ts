const APP_AUTH_STORAGE_KEY = 'hermes.appRelay.authSession'

export interface AppAccountUser {
  id: number
  email: string
  displayName: string
  avatarUrl: string
  emailVerified: boolean
}

export interface AppAuthSession {
  accessToken: string
  refreshToken: string
  expiresIn: string
  user: AppAccountUser
}

interface StoredAppAuthSession extends AppAuthSession {
  baseUrl: string
}

interface AppAuthResponse extends AppAuthSession {
  ok: boolean
}

export interface AppAuthConfig {
  emailVerificationEnabled: boolean
}

export class AppAuthRequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

export async function registerAppAccount(baseUrl: string, input: {
  email: string
  password: string
  verificationCode: string
  displayName?: string
}): Promise<AppAuthSession> {
  const session = await appAuthRequest<AppAuthResponse>(baseUrl, '/api/app/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return storeSession(baseUrl, session)
}

export async function fetchAppAuthConfig(baseUrl: string): Promise<AppAuthConfig> {
  const response = await appAuthRequest<{
    ok: boolean
    emailVerificationEnabled?: boolean
  }>(baseUrl, '/api/app/auth/config')
  return {
    emailVerificationEnabled: response.emailVerificationEnabled === true,
  }
}

export async function sendAppRegistrationCode(baseUrl: string, email: string): Promise<{
  expiresIn: number
  retryAfter: number
}> {
  const response = await appAuthRequest<{
    ok: boolean
    expiresIn?: number
    retryAfter?: number
  }>(baseUrl, '/api/app/auth/email-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  return {
    expiresIn: Number(response.expiresIn || 0),
    retryAfter: Number(response.retryAfter || 60),
  }
}

export async function loginAppAccount(baseUrl: string, input: {
  email: string
  password: string
}): Promise<AppAuthSession> {
  const session = await appAuthRequest<AppAuthResponse>(baseUrl, '/api/app/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return storeSession(baseUrl, session)
}

export async function restoreAppAccount(baseUrl: string): Promise<AppAuthSession | null> {
  const stored = readStoredSession()
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  if (!stored || stored.baseUrl !== normalizedBaseUrl) {
    if (stored) clearAppAccount()
    return null
  }

  try {
    const response = await appAuthRequest<{ ok: boolean; user: AppAccountUser }>(
      normalizedBaseUrl,
      '/api/app/auth/me',
      { headers: { Authorization: `Bearer ${stored.accessToken}` } },
    )
    return storeSession(normalizedBaseUrl, { ...stored, user: response.user })
  } catch (error) {
    if (!(error instanceof AppAuthRequestError) || error.status !== 401) throw error
  }

  try {
    const refreshed = await appAuthRequest<AppAuthResponse>(normalizedBaseUrl, '/api/app/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: stored.refreshToken }),
    })
    return storeSession(normalizedBaseUrl, refreshed)
  } catch (error) {
    if (error instanceof AppAuthRequestError && error.status === 401) clearAppAccount()
    throw error
  }
}

export async function logoutAppAccount(baseUrl: string): Promise<void> {
  const stored = readStoredSession()
  try {
    if (stored?.refreshToken && stored.baseUrl === normalizeBaseUrl(baseUrl)) {
      await appAuthRequest(baseUrl, '/api/app/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: stored.refreshToken }),
      })
    }
  } finally {
    clearAppAccount()
  }
}

export function clearAppAccount(): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(APP_AUTH_STORAGE_KEY)
}

function storeSession(baseUrl: string, session: AppAuthSession): AppAuthSession {
  const stored: StoredAppAuthSession = {
    baseUrl: normalizeBaseUrl(baseUrl),
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    user: session.user,
  }
  localStorage.setItem(APP_AUTH_STORAGE_KEY, JSON.stringify(stored))
  return {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    expiresIn: stored.expiresIn,
    user: stored.user,
  }
}

function readStoredSession(): StoredAppAuthSession | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const value = JSON.parse(localStorage.getItem(APP_AUTH_STORAGE_KEY) || 'null')
    if (!value || typeof value !== 'object') return null
    if (
      typeof value.baseUrl !== 'string' ||
      typeof value.accessToken !== 'string' ||
      typeof value.refreshToken !== 'string' ||
      !value.user ||
      typeof value.user.email !== 'string'
    ) return null
    return value as StoredAppAuthSession
  } catch {
    return null
  }
}

async function appAuthRequest<T = { ok: boolean }>(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || payload.ok === false) {
    throw new AppAuthRequestError(String(payload.error || 'app_auth_failed'), response.status)
  }
  return payload as T
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid_app_auth_url')
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
