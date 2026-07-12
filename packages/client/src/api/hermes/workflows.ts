import { request } from '../client'

export interface WorkflowViewport {
  x: number
  y: number
  zoom: number
}

export interface WorkflowRecord {
  id: string
  name: string
  profile: string
  workspace: string | null
  nodes: unknown[]
  edges: unknown[]
  viewport: WorkflowViewport | Record<string, unknown> | null
  created_at: number
  updated_at: number
}

export interface WorkflowCreateRequest {
  name: string
  profile?: string | null
  workspace?: string | null
  nodes?: unknown[]
  edges?: unknown[]
  viewport?: WorkflowViewport
}

export interface WorkflowUpdateRequest {
  name?: string
  workspace?: string | null
  nodes?: unknown[]
  edges?: unknown[]
  viewport?: WorkflowViewport
}

export interface WorkflowBatchDeleteResult {
  deleted: number
  failed: number
  errors: Array<{ id: string; error: string }>
}

export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
export type WorkflowRunNodeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'approval_rejected' | 'canceled'

export interface WorkflowRunRecord {
  id: string
  workflow_id: string
  profile: string
  workspace: string | null
  start_node_ids: string[]
  status: WorkflowRunStatus
  snapshot_nodes: unknown[]
  snapshot_edges: unknown[]
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at?: number
  error: string | null
  node_sessions?: WorkflowRunNodeSessionRecord[]
}

export interface WorkflowRunNodeSessionRecord {
  id: string
  run_id: string
  workflow_id: string
  node_id: string
  session_id: string
  profile: string
  agent: string
  agent_mode: string
  status: WorkflowRunNodeStatus
  sequence: number
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
  error: string | null
}

export interface WorkflowRunNowRequest {
  start_node_ids?: string[]
  input?: string | null
  timeout_ms?: number
}

export interface WorkflowRerunFromNodeRequest {
  preserve_start_node?: boolean
  timeout_ms?: number
}

export interface WorkflowRunNowResult {
  run: WorkflowRunRecord
  nodeSessions: WorkflowRunNodeSessionRecord[]
}

export interface WorkflowRunStartResult {
  ok: true
  status: 'accepted'
}

function appendProfile(path: string, profile?: string | null): string {
  if (!profile) return path
  const params = new URLSearchParams()
  params.set('profile', profile)
  return `${path}?${params}`
}

export async function listWorkflows(profile?: string | null): Promise<WorkflowRecord[]> {
  const path = appendProfile('/api/hermes/workflows', profile)
  const res = await request<{ workflows: WorkflowRecord[] }>(path)
  return res.workflows
}

export async function fetchWorkflow(id: string): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>(`/api/hermes/workflows/${encodeURIComponent(id)}`)
  return res.workflow
}

export async function createWorkflow(input: WorkflowCreateRequest): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>('/api/hermes/workflows', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.workflow
}

export async function updateWorkflow(id: string, patch: WorkflowUpdateRequest): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>(`/api/hermes/workflows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return res.workflow
}

export async function deleteWorkflow(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/hermes/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function batchDeleteWorkflows(ids: string[]): Promise<WorkflowBatchDeleteResult> {
  return request<WorkflowBatchDeleteResult>('/api/hermes/workflows/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export async function listWorkflowRuns(id: string, limit = 100): Promise<WorkflowRunRecord[]> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  const res = await request<{ runs: WorkflowRunRecord[] }>(`/api/hermes/workflows/${encodeURIComponent(id)}/runs?${params}`)
  return res.runs
}

export async function stopWorkflowRun(id: string, runId: string): Promise<WorkflowRunRecord> {
  const res = await request<{ ok: true; run: WorkflowRunRecord }>(
    `/api/hermes/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/stop`,
    { method: 'POST' },
  )
  return res.run
}

export async function deleteWorkflowRun(id: string, runId: string): Promise<void> {
  await request<{ ok: true }>(
    `/api/hermes/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
  )
}

export async function approveWorkflowNode(id: string, runId: string, nodeId: string, approved: boolean): Promise<void> {
  await request<{ ok: true }>(
    `/api/hermes/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
    {
      method: 'POST',
      body: JSON.stringify({ approved }),
    },
  )
}

export async function runWorkflowNow(id: string, input: WorkflowRunNowRequest = {}): Promise<WorkflowRunStartResult> {
  return request<WorkflowRunStartResult>(`/api/hermes/workflows/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function rerunWorkflowRunFromNode(
  id: string,
  runId: string,
  nodeId: string,
  input: WorkflowRerunFromNodeRequest = {},
): Promise<WorkflowRunStartResult> {
  return request<WorkflowRunStartResult>(
    `/api/hermes/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/rerun-from-node`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        node_id: nodeId,
      }),
    },
  )
}
