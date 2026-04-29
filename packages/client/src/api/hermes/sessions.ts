import { request } from '../client'

export interface SessionSummary {
  id: string
  source: string
  model: string
  title: string | null
  preview?: string
  started_at: number
  ended_at: number | null
  last_active?: number
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
}

export interface SessionDetail extends SessionSummary {
  messages: HermesMessage[]
}

export interface SessionSearchResult extends SessionSummary {
  matched_message_id: number | null
  snippet: string
  rank: number
}

export interface HermesMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
}

export async function fetchSessions(source?: string, limit?: number): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  const query = params.toString()
  const res = await request<{ sessions: SessionSummary[] }>(`/api/hermes/sessions${query ? `?${query}` : ''}`)
  return res.sessions
}

export async function searchSessions(q: string, source?: string, limit?: number): Promise<SessionSearchResult[]> {
  const params = new URLSearchParams()
  params.set('q', q)
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  const query = params.toString()
  const res = await request<{ results: SessionSearchResult[] }>(`/api/hermes/search/sessions?${query}`)
  return res.results
}

export async function fetchSession(id: string): Promise<SessionDetail | null> {
  try {
    const res = await request<{ session: SessionDetail }>(`/api/hermes/sessions/${id}`)
    return res.session
  } catch {
    return null
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${id}`, { method: 'DELETE' })
    return true
  } catch {
    return false
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

export interface UsageStatsResponse {
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_cache_write_tokens: number
  total_reasoning_tokens: number
  total_sessions: number
  total_cost: number
  model_usage: Array<{
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    sessions: number
  }>
  daily_usage: Array<{
    date: string
    tokens: number
    cache: number
    sessions: number
    cost: number
  }>
}

export async function fetchUsageStats(): Promise<UsageStatsResponse> {
  return request<UsageStatsResponse>('/api/hermes/usage/stats')
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

export async function fetchContextLength(profile?: string): Promise<number> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ context_length: number }>(`/api/hermes/sessions/context-length${query ? `?${query}` : ''}`)
  return res.context_length
}
