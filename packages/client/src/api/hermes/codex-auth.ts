import { request } from '../client'

export interface CodexStartResult {
  session_id: string
  user_code: string
  verification_url: string
  open_url?: string
  expires_in: number
}

export interface CodexPollResult {
  status: 'pending' | 'approved' | 'expired' | 'error'
  error: string | null
}

export interface CodexAccount {
  id: string
  label: string
  email?: string | null
  account_id?: string | null
  last_refresh?: string | null
  active: boolean
}

export interface CodexStatusResult {
  authenticated: boolean
  last_refresh?: string
  active_account_id?: string | null
  accounts: CodexAccount[]
}

export async function startCodexLogin(preferredModel?: string): Promise<CodexStartResult> {
  return request<CodexStartResult>('/api/hermes/auth/codex/start', {
    method: 'POST',
    body: JSON.stringify({ preferred_model: preferredModel || undefined }),
  })
}

export async function pollCodexLogin(sessionId: string): Promise<CodexPollResult> {
  return request<CodexPollResult>(`/api/hermes/auth/codex/poll/${sessionId}`)
}

export async function getCodexAuthStatus(): Promise<CodexStatusResult> {
  return request<CodexStatusResult>('/api/hermes/auth/codex/status')
}

export async function switchCodexAccount(credentialId: string, preferredModel?: string): Promise<void> {
  await request('/api/hermes/auth/codex/switch', {
    method: 'POST',
    body: JSON.stringify({ credential_id: credentialId, preferred_model: preferredModel || undefined }),
  })
}

export async function deleteCodexAccount(credentialId: string): Promise<void> {
  await request(`/api/hermes/auth/codex/accounts/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE',
  })
}
