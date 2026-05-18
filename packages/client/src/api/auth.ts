import { request } from './client'

export interface AuthStatus {
  hasPasswordLogin: boolean
  username: string | null
  authMode?: string
  plane?: string
}

export interface CurrentUser {
  openid: string
  profile: string
  role: 'user' | 'admin'
  name?: string
  avatarUrl?: string
}

export interface FeishuUatStatus {
  status: 'missing' | 'valid' | 'expired' | 'scope_missing' | string
  profile_name?: string
  subject_id?: string
  missing_scopes?: string[]
  scopes?: string[]
  expires_at?: number | null
  lark_cli?: {
    available?: boolean
    default_identity?: 'user' | 'bot' | string
  }
}

export interface FeishuUatAuthSession {
  status: 'pending' | 'success' | 'error' | 'expired' | string
  session_id: string
  verification_uri?: string
  user_code?: string
  expires_at?: number
  interval?: number
  error?: string
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status')
  if (!res.ok) throw new Error('Failed to fetch auth status')
  return res.json()
}

export async function loginWithPassword(username: string, password: string): Promise<string> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err: any = new Error(data.error || 'Login failed')
    err.status = res.status
    throw err
  }
  const data = await res.json()
  return data.token
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  return request('/api/auth/me')
}

export async function fetchFeishuUatStatus(requiredScopes?: string): Promise<FeishuUatStatus> {
  const suffix = requiredScopes ? `?required_scopes=${encodeURIComponent(requiredScopes)}` : ''
  return request(`/api/auth/feishu/uat/status${suffix}`)
}

export async function startFeishuUatAuth(scope?: string): Promise<FeishuUatAuthSession> {
  return request('/api/auth/feishu/uat/start', {
    method: 'POST',
    body: JSON.stringify(scope ? { scope } : {}),
  })
}

export async function pollFeishuUatAuth(sessionId: string): Promise<FeishuUatAuthSession> {
  return request(`/api/auth/feishu/uat/sessions/${encodeURIComponent(sessionId)}`)
}

export async function setupPassword(username: string, password: string): Promise<void> {
  return request('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

export async function changeUsername(currentPassword: string, newUsername: string): Promise<void> {
  return request('/api/auth/change-username', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newUsername }),
  })
}

export async function removePassword(): Promise<void> {
  return request('/api/auth/password', {
    method: 'DELETE',
  })
}

export interface LockedIp {
  ip: string
  type: 'password' | 'token'
  failures: number
  lockedUntil: number
}

export async function fetchLockedIps(): Promise<LockedIp[]> {
  const res = await request<{ locks: LockedIp[] }>('/api/auth/locked-ips')
  return res.locks
}

export async function unlockSpecificIp(ip: string): Promise<void> {
  return request(`/api/auth/locked-ips?ip=${encodeURIComponent(ip)}`, {
    method: 'DELETE',
  })
}

export async function unlockAllIps(): Promise<number> {
  const res = await request<{ count: number }>('/api/auth/locked-ips', {
    method: 'DELETE',
  })
  return res.count
}
