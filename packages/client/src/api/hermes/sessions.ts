import { request, getApiKey, getBaseUrlValue } from '../client'
import type { ProviderApiMode } from './system'

export interface SessionSummary {
  id: string
  profile?: string | null
  source: string
  agent?: string
  agent_mode?: 'global' | 'scoped' | string
  agent_session_id?: string
  agent_native_session_id?: string
  model: string
  provider?: string
  api_mode?: ProviderApiMode
  title: string | null
  parent_session_id?: string | null
  fork_point_message_id?: string | null
  parent_title?: string | null
  parent_last_message?: string | null
  parent_last_message_role?: string | null
  preview?: string
  started_at: number
  ended_at: number | null
  last_active?: number
  is_archived?: number | boolean
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  workspace?: string | null
  webui_imported?: boolean
}

export interface SessionDetail extends SessionSummary {
  messages: HermesMessage[]
}

export interface SessionContextMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  reasoning?: string | null
  reasoning_content?: string | null
}

export interface SessionContext {
  session_id: string
  profile?: string | null
  source?: string
  title?: string | null
  messages: SessionContextMessage[]
  message_count: number
}

export interface PaginatedSessionMessages {
  session: SessionSummary
  messages: HermesMessage[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface SessionSearchResult extends SessionSummary {
  matched_message_id: number | null
  snippet: string
  rank: number
}

export interface HermesMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'command' | 'moa'
  content: string
  display_role?: 'user' | 'assistant' | 'system' | 'tool' | 'command' | null
  display_content?: string | null
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
}

export interface WorkspaceRunChangeFileSummary {
  id: number
  change_id: string
  session_id: string
  path: string
  old_path: string | null
  change_type: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  size_before: number | null
  size_after: number | null
  patch_bytes: number
  truncated: boolean
  binary: boolean
  created_at: number
}

export interface WorkspaceRunChangeFileDetail extends WorkspaceRunChangeFileSummary {
  patch: string | null
}

export interface WorkspaceRunChangeSummary {
  change_id: string
  session_id: string
  run_id: string
  source: 'run'
  workspace: string
  workspace_kind: 'git' | 'filesystem'
  started_at: number
  finished_at: number
  files_changed: number
  additions: number
  deletions: number
  truncated: boolean
  total_patch_bytes: number
  created_at: number
  files: WorkspaceRunChangeFileSummary[]
}

export async function fetchSessions(source?: string, limit?: number, profile?: string): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ sessions: SessionSummary[] }>(`/api/hermes/sessions${query ? `?${query}` : ''}`)
  return res.sessions
}

export async function fetchWorkspaceRunChangesForSession(id: string): Promise<WorkspaceRunChangeSummary[]> {
  try {
    const res = await request<{ changes: WorkspaceRunChangeSummary[] }>(
      `/api/hermes/sessions/${encodeURIComponent(id)}/workspace-run-changes`,
    )
    return Array.isArray(res.changes) ? res.changes : []
  } catch {
    return []
  }
}

export async function fetchWorkspaceRunChangeFile(
  sessionId: string,
  changeId: string,
  fileId: number,
): Promise<WorkspaceRunChangeFileDetail | null> {
  try {
    const res = await request<{ file: WorkspaceRunChangeFileDetail }>(
      `/api/hermes/sessions/${encodeURIComponent(sessionId)}/workspace-run-changes/${encodeURIComponent(changeId)}/files/${encodeURIComponent(String(fileId))}`,
    )
    return res.file
  } catch {
    return null
  }
}

export async function readSessionWorkspaceFile(
  sessionId: string,
  path: string,
): Promise<{ content: string; path: string; size: number }> {
  const params = new URLSearchParams({ path })
  return request<{ content: string; path: string; size: number }>(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/workspace-file/read?${params}`,
  )
}

export async function listSessionWorkspaceFiles(
  sessionId: string,
  path: string = '',
): Promise<{ entries: Array<{ name: string; path: string; absolutePath?: string; isDir: boolean; size: number; modTime: string }>; path: string; absolutePath?: string }> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  return request(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/workspace-files/list${query ? `?${query}` : ''}`)
}

export async function writeSessionWorkspaceFile(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/workspace-file/write`,
    {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    },
  )
}

export async function mkdirSessionWorkspaceFile(sessionId: string, path: string): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/workspace-file/mkdir`,
    { method: 'POST', body: JSON.stringify({ path }) },
  )
}

export async function deleteSessionWorkspaceFile(sessionId: string, path: string, recursive = false): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/workspace-file/delete`,
    { method: 'DELETE', body: JSON.stringify({ path, recursive }) },
  )
}

export async function renameSessionWorkspaceFile(sessionId: string, oldPath: string, newPath: string): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/workspace-file/rename`,
    { method: 'POST', body: JSON.stringify({ oldPath, newPath }) },
  )
}

export async function copySessionWorkspaceFile(sessionId: string, srcPath: string, destPath: string): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/workspace-file/copy`,
    { method: 'POST', body: JSON.stringify({ srcPath, destPath }) },
  )
}

/**
 * Fetch Hermes sessions only (exclude api_server source)
 */
export async function fetchHermesSessions(source?: string, limit?: number, profile?: string | null): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ sessions: SessionSummary[] }>(`/api/hermes/sessions/hermes${query ? `?${query}` : ''}`)
  return res.sessions
}

export async function searchSessions(q: string, source?: string, limit?: number, profile?: string): Promise<SessionSearchResult[]> {
  const params = new URLSearchParams()
  params.set('q', q)
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ results: SessionSearchResult[] }>(`/api/hermes/search/sessions?${query}`)
  return res.results
}

export async function fetchSession(id: string, profile?: string | null): Promise<SessionDetail | null> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    const res = await request<{ session: SessionDetail }>(`/api/hermes/sessions/${id}${query ? `?${query}` : ''}`)
    return res.session
  } catch {
    return null
  }
}

export async function fetchSessionContext(id: string, profile?: string | null): Promise<SessionContext | null> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    return await request<SessionContext>(`/api/hermes/sessions/${encodeURIComponent(id)}/context${query ? `?${query}` : ''}`)
  } catch {
    return null
  }
}

export async function fetchSessionMessagesPage(
  id: string,
  offset: number,
  limit = 150,
  profile?: string | null,
): Promise<PaginatedSessionMessages | null> {
  try {
    const params = new URLSearchParams()
    params.set('offset', String(offset))
    params.set('limit', String(limit))
    if (profile) params.set('profile', profile)
    const res = await request<PaginatedSessionMessages>(
      `/api/hermes/sessions/conversations/${encodeURIComponent(id)}/messages/paginated?${params}`,
    )
    return res
  } catch {
    return null
  }
}

/**
 * Fetch Hermes session detail only (exclude api_server source)
 */
export async function fetchHermesSession(id: string, profile?: string | null): Promise<SessionDetail | null> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    const res = await request<{ session: SessionDetail }>(`/api/hermes/sessions/hermes/${id}${query ? `?${query}` : ''}`)
    return res.session
  } catch {
    return null
  }
}

export async function deleteSession(id: string, profile?: string | null): Promise<boolean> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    await request(`/api/hermes/sessions/${id}${query ? `?${query}` : ''}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}

export async function importHermesSession(id: string, profile?: string | null): Promise<{ ok: boolean; imported: boolean; session?: SessionDetail }> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  const query = params.toString()
  return request<{ ok: boolean; imported: boolean; session?: SessionDetail }>(
    `/api/hermes/sessions/hermes/${encodeURIComponent(id)}/import${query ? `?${query}` : ''}`,
    { method: 'POST' },
  )
}

export interface BatchDeleteSessionTarget {
  id: string
  profile?: string | null
}

export async function batchDeleteSessions(targets: Array<string | BatchDeleteSessionTarget>): Promise<{ deleted: number; failed: number; errors: Array<{ id: string; error: string }> }> {
  try {
    const sessions = targets.map(target =>
      typeof target === 'string'
        ? { id: target }
        : { id: target.id, profile: target.profile || undefined },
    )
    const res = await request<{ deleted: number; failed: number; errors: Array<{ id: string; error: string }> }>(
      '/api/hermes/sessions/batch-delete',
      {
        method: 'POST',
        body: JSON.stringify({
          ids: sessions.map(session => session.id),
          sessions,
        }),
      }
    )
    return res
  } catch (err: any) {
    throw err
  }
}

export async function renameSession(id: string, title: string): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    })
    return true
  } catch {
    return false
  }
}

export async function archiveSession(id: string): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${id}/archive`, { method: 'POST' })
    return true
  } catch {
    return false
  }
}

export async function unarchiveSession(id: string): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${id}/unarchive`, { method: 'POST' })
    return true
  } catch {
    return false
  }
}

export async function setSessionWorkspace(id: string, workspace: string | null): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${id}/workspace`, {
      method: 'POST',
      body: JSON.stringify({ workspace: workspace || '' }),
    })
    return true
  } catch {
    return false
  }
}

export async function setSessionModel(id: string, model: string, provider: string, apiMode?: ProviderApiMode): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${id}/model`, {
      method: 'POST',
      body: JSON.stringify({ model, provider, apiMode }),
    })
    return true
  } catch {
    return false
  }
}

export async function exportSession(id: string, mode: 'full' | 'compressed' = 'full', ext: 'json' | 'txt' = 'json'): Promise<void> {
  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  const url = `${baseUrl}/api/hermes/sessions/${id}/export?mode=${mode}&ext=${ext}&token=${encodeURIComponent(token)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Export failed')
  const blob = await res.blob()
  const contentDisposition = res.headers.get('Content-Disposition') || ''
  let filename = `session_${id}.${ext}`
  const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?([^;\n]+)/i)
  if (match) {
    const dispositionFilename = match[1].replace(/"/g, '')
    try {
      filename = decodeURIComponent(dispositionFilename)
    } catch {
      filename = dispositionFilename
    }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export interface UsageStatsResponse {
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_cache_write_tokens: number
  total_reasoning_tokens: number
  total_sessions: number
  total_cost: number
  total_api_calls?: number
  period_days?: number
  model_usage: Array<{
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    sessions: number
  }>
  agent_usage?: Array<{
    agent: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    sessions: number
  }>
  daily_usage: Array<{
    date: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    sessions: number
    errors: number
    cost: number
  }>
}

export async function fetchUsageStats(days = 30): Promise<UsageStatsResponse> {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 30
  const params = new URLSearchParams()
  params.set('days', String(safeDays))
  return request<UsageStatsResponse>(`/api/hermes/usage/stats?${params}`)
}

export async function fetchSessionUsage(ids: string[]): Promise<Record<string, { input_tokens: number; output_tokens: number }>> {
  if (ids.length === 0) return {}
  const params = new URLSearchParams()
  params.set('ids', ids.join(','))
  return request(`/api/hermes/sessions/usage?${params}`)
}

export async function fetchSessionUsageSingle(id: string): Promise<{ input_tokens: number; output_tokens: number } | null> {
  try {
    return await request<{ input_tokens: number; output_tokens: number }>(`/api/hermes/sessions/${id}/usage`)
  } catch {
    return null
  }
}

export async function fetchContextLength(profile?: string, provider?: string, model?: string): Promise<number> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  if (provider) params.set('provider', provider)
  if (model) params.set('model', model)
  const query = params.toString()
  const res = await request<{ context_length: number }>(`/api/hermes/sessions/context-length${query ? `?${query}` : ''}`)
  return res.context_length
}
