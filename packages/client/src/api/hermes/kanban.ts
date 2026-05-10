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

export interface KanbanBoard {
  slug: string
  name: string
  description: string
  icon: string
  color: string
  created_at: number | null
  archived: boolean
  db_path?: string
  is_current?: boolean
  counts: Record<string, number>
  total: number
}

export interface KanbanBoardCreateRequest {
  slug: string
  name?: string
  description?: string
  icon?: string
  color?: string
  switchCurrent?: boolean
}

export interface KanbanCapabilities {
  source: 'hermes-cli'
  supports: Record<string, boolean>
  missing: string[]
}

export interface KanbanCreateRequest {
  title: string
  body?: string
  assignee?: string
  priority?: number
  tenant?: string
}

export interface KanbanBoardOptions {
  board?: string
}

export interface KanbanListOptions extends KanbanBoardOptions {
  status?: string
  assignee?: string
  tenant?: string
}

function normalizedBoard(board?: string): string {
  const trimmed = board?.trim()
  return trimmed || 'default'
}

function appendQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

function boardParams(board?: string): URLSearchParams {
  const params = new URLSearchParams()
  params.set('board', normalizedBoard(board))
  return params
}

// ─── API functions ───────────────────────────────────────────────

export async function listBoards(opts?: { includeArchived?: boolean }): Promise<KanbanBoard[]> {
  const params = new URLSearchParams()
  if (opts?.includeArchived) params.set('includeArchived', 'true')
  const res = await request<{ boards: KanbanBoard[] }>(appendQuery('/api/hermes/kanban/boards', params))
  return res.boards
}

export async function createBoard(data: KanbanBoardCreateRequest): Promise<KanbanBoard> {
  const res = await request<{ board: KanbanBoard }>('/api/hermes/kanban/boards', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.board
}

export async function archiveBoard(slug: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/hermes/kanban/boards/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
}

export async function getCapabilities(): Promise<KanbanCapabilities> {
  const res = await request<{ capabilities: KanbanCapabilities }>('/api/hermes/kanban/capabilities')
  return res.capabilities
}

export async function listTasks(opts?: KanbanListOptions): Promise<KanbanTask[]> {
  const params = boardParams(opts?.board)
  if (opts?.status) params.set('status', opts.status)
  if (opts?.assignee) params.set('assignee', opts.assignee)
  if (opts?.tenant) params.set('tenant', opts.tenant)
  const res = await request<{ tasks: KanbanTask[] }>(appendQuery('/api/hermes/kanban', params))
  return res.tasks
}

export async function getTask(id: string, opts?: KanbanBoardOptions): Promise<KanbanTaskDetail> {
  return request<KanbanTaskDetail>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(id)}`, boardParams(opts?.board)))
}

export async function createTask(data: KanbanCreateRequest, opts?: KanbanBoardOptions): Promise<KanbanTask> {
  const res = await request<{ task: KanbanTask }>(appendQuery('/api/hermes/kanban', boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.task
}

export async function completeTasks(taskIds: string[], summary?: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(appendQuery('/api/hermes/kanban/complete', boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds, summary }),
  })
}

export async function blockTask(taskId: string, reason: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/block`, boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export async function unblockTasks(taskIds: string[], opts?: KanbanBoardOptions): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(appendQuery('/api/hermes/kanban/unblock', boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds }),
  })
}

export async function assignTask(taskId: string, profile: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(appendQuery(`/api/hermes/kanban/${encodeURIComponent(taskId)}/assign`, boardParams(opts?.board)), {
    method: 'POST',
    body: JSON.stringify({ profile }),
  })
}

export async function getStats(opts?: KanbanBoardOptions): Promise<KanbanStats> {
  const res = await request<{ stats: KanbanStats }>(appendQuery('/api/hermes/kanban/stats', boardParams(opts?.board)))
  return res.stats
}

export async function getAssignees(opts?: KanbanBoardOptions): Promise<KanbanAssignee[]> {
  const res = await request<{ assignees: KanbanAssignee[] }>(appendQuery('/api/hermes/kanban/assignees', boardParams(opts?.board)))
  return res.assignees
}
