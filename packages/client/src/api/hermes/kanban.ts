import { request } from '../client'

// ─── Types ──────────────────────────────────────────────────────

export type KanbanTaskStatus = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'done' | 'archived'

export interface KanbanTask {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: KanbanTaskStatus
  priority: number
  created_by: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  workspace_kind: string
  workspace_path: string | null
  tenant: string | null
  result: string | null
  skills: string[] | null
}

export interface KanbanRun {
  id: number
  task_id: string
  profile: string | null
  status: string
  outcome: string | null
  summary: string | null
  error: string | null
  metadata: Record<string, unknown> | null
  worker_pid: number | null
  started_at: number
  ended_at: number | null
}

export interface KanbanComment {
  id: number
  task_id: string
  author: string
  body: string
  created_at: number
}

export interface KanbanEvent {
  id: number
  task_id: string
  kind: string
  payload: Record<string, unknown> | null
  created_at: number
  run_id: number | null
}

export interface KanbanTaskMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
}

export interface KanbanTaskSession {
  id: string
  title: string | null
  source: string
  model: string
  started_at: number
  ended_at: number | null
  messages: KanbanTaskMessage[]
}

export interface KanbanTaskDetail {
  task: KanbanTask
  latest_summary: string | null
  session?: KanbanTaskSession
  comments: KanbanComment[]
  events: KanbanEvent[]
  runs: KanbanRun[]
}

export interface KanbanStats {
  by_status: Record<string, number>
  by_assignee: Record<string, number>
  total: number
}

export interface KanbanAssignee {
  name: string
  on_disk: boolean
  counts: Record<string, number> | null
}

export interface KanbanCreateRequest {
  title: string
  body?: string
  assignee?: string
  priority?: number
  tenant?: string
}

// ─── API functions ───────────────────────────────────────────────

export async function listTasks(opts?: {
  status?: string
  assignee?: string
  tenant?: string
}): Promise<KanbanTask[]> {
  const params = new URLSearchParams()
  if (opts?.status) params.set('status', opts.status)
  if (opts?.assignee) params.set('assignee', opts.assignee)
  if (opts?.tenant) params.set('tenant', opts.tenant)
  const qs = params.toString()
  const res = await request<{ tasks: KanbanTask[] }>(`/api/hermes/kanban${qs ? `?${qs}` : ''}`)
  return res.tasks
}

export async function getTask(id: string): Promise<KanbanTaskDetail> {
  return request<KanbanTaskDetail>(`/api/hermes/kanban/${id}`)
}

export async function createTask(data: KanbanCreateRequest): Promise<KanbanTask> {
  const res = await request<{ task: KanbanTask }>('/api/hermes/kanban', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.task
}

export async function completeTasks(taskIds: string[], summary?: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/hermes/kanban/complete', {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds, summary }),
  })
}

export async function blockTask(taskId: string, reason: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/hermes/kanban/${taskId}/block`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export async function unblockTasks(taskIds: string[]): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/hermes/kanban/unblock', {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds }),
  })
}

export async function assignTask(taskId: string, profile: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/hermes/kanban/${taskId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ profile }),
  })
}

export async function getStats(): Promise<KanbanStats> {
  const res = await request<{ stats: KanbanStats }>('/api/hermes/kanban/stats')
  return res.stats
}

export async function getAssignees(): Promise<KanbanAssignee[]> {
  const res = await request<{ assignees: KanbanAssignee[] }>('/api/hermes/kanban/assignees')
  return res.assignees
}
