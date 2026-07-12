import { randomUUID } from 'crypto'
import { getDb, jsonDelete, jsonGet, jsonGetAll, jsonSet } from '../index'
import { WORKFLOW_RUN_NODE_SESSIONS_TABLE, WORKFLOW_RUNS_TABLE } from './schemas'

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
  error: string | null
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

function profileName(value?: string | null): string {
  return value?.trim() || 'default'
}

function parseArrayJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function rowToRunRecord(row: Record<string, any>): WorkflowRunRecord {
  return {
    id: String(row.id || ''),
    workflow_id: String(row.workflow_id || ''),
    profile: profileName(row.profile),
    workspace: row.workspace == null || row.workspace === '' ? null : String(row.workspace),
    start_node_ids: parseArrayJson(row.start_node_ids_json ?? row.start_node_ids).map(String),
    status: String(row.status || 'queued') as WorkflowRunStatus,
    snapshot_nodes: parseArrayJson(row.snapshot_nodes_json ?? row.snapshot_nodes),
    snapshot_edges: parseArrayJson(row.snapshot_edges_json ?? row.snapshot_edges),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: Number(row.created_at || 0),
    error: row.error == null || row.error === '' ? null : String(row.error),
  }
}

function rowToNodeSessionRecord(row: Record<string, any>): WorkflowRunNodeSessionRecord {
  return {
    id: String(row.id || ''),
    run_id: String(row.run_id || ''),
    workflow_id: String(row.workflow_id || ''),
    node_id: String(row.node_id || ''),
    session_id: String(row.session_id || ''),
    profile: profileName(row.profile),
    agent: String(row.agent || ''),
    agent_mode: String(row.agent_mode || ''),
    status: String(row.status || 'queued') as WorkflowRunNodeStatus,
    sequence: Number(row.sequence || 0),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    error: row.error == null || row.error === '' ? null : String(row.error),
  }
}

export function createWorkflowRun(input: {
  id?: string
  workflow_id: string
  profile?: string | null
  workspace?: string | null
  start_node_ids?: string[]
  status?: WorkflowRunStatus
  snapshot_nodes?: unknown[]
  snapshot_edges?: unknown[]
  started_at?: number | null
  error?: string | null
}): WorkflowRunRecord {
  const now = Date.now()
  const record: WorkflowRunRecord = {
    id: input.id?.trim() || randomUUID(),
    workflow_id: input.workflow_id,
    profile: profileName(input.profile),
    workspace: input.workspace?.trim() || null,
    start_node_ids: input.start_node_ids || [],
    status: input.status || 'queued',
    snapshot_nodes: input.snapshot_nodes || [],
    snapshot_edges: input.snapshot_edges || [],
    started_at: input.started_at ?? null,
    finished_at: null,
    created_at: now,
    error: input.error || null,
  }
  const row = {
    id: record.id,
    workflow_id: record.workflow_id,
    profile: record.profile,
    workspace: record.workspace,
    start_node_ids_json: JSON.stringify(record.start_node_ids),
    status: record.status,
    snapshot_nodes_json: JSON.stringify(record.snapshot_nodes),
    snapshot_edges_json: JSON.stringify(record.snapshot_edges),
    started_at: record.started_at,
    finished_at: record.finished_at,
    created_at: record.created_at,
    error: record.error,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUNS_TABLE, record.id, row as any)
    return record
  }
  db.prepare(`
    INSERT INTO ${WORKFLOW_RUNS_TABLE} (
      id, workflow_id, profile, workspace, start_node_ids_json, status,
      snapshot_nodes_json, snapshot_edges_json, started_at, finished_at, created_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.workflow_id,
    row.profile,
    row.workspace,
    row.start_node_ids_json,
    row.status,
    row.snapshot_nodes_json,
    row.snapshot_edges_json,
    row.started_at,
    row.finished_at,
    row.created_at,
    row.error,
  )
  return record
}

export function updateWorkflowRun(id: string, patch: {
  status?: WorkflowRunStatus
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}): WorkflowRunRecord | null {
  const existing = getWorkflowRun(id)
  if (!existing) return null
  const next: WorkflowRunRecord = {
    ...existing,
    status: patch.status ?? existing.status,
    started_at: patch.started_at === undefined ? existing.started_at : patch.started_at,
    finished_at: patch.finished_at === undefined ? existing.finished_at : patch.finished_at,
    error: patch.error === undefined ? existing.error : patch.error,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUNS_TABLE, id, {
      ...next,
      start_node_ids_json: JSON.stringify(next.start_node_ids),
      snapshot_nodes_json: JSON.stringify(next.snapshot_nodes),
      snapshot_edges_json: JSON.stringify(next.snapshot_edges),
    } as any)
    return next
  }
  db.prepare(`
    UPDATE ${WORKFLOW_RUNS_TABLE}
    SET status = ?, started_at = ?, finished_at = ?, error = ?
    WHERE id = ?
  `).run(next.status, next.started_at, next.finished_at, next.error, id)
  return next
}

export function getWorkflowRun(id: string): WorkflowRunRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(WORKFLOW_RUNS_TABLE, id)
    return row ? rowToRunRecord(row) : null
  }
  const row = db.prepare(`SELECT * FROM ${WORKFLOW_RUNS_TABLE} WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToRunRecord(row) : null
}

export function deleteWorkflowRun(id: string): boolean {
  const existing = getWorkflowRun(id)
  if (!existing) return false
  const db = getDb()
  if (!db) {
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE)).map(rowToNodeSessionRecord)) {
      if (record.run_id === id) jsonDelete(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id)
    }
    jsonDelete(WORKFLOW_RUNS_TABLE, id)
    return true
  }
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} WHERE run_id = ?`).run(id)
    db.prepare(`DELETE FROM ${WORKFLOW_RUNS_TABLE} WHERE id = ?`).run(id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return true
}

export function listWorkflowRuns(workflowId?: string | null, limit = 100): WorkflowRunRecord[] {
  const normalizedWorkflowId = workflowId?.trim() || ''
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 100))
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(WORKFLOW_RUNS_TABLE))
      .map(rowToRunRecord)
      .filter(record => !normalizedWorkflowId || record.workflow_id === normalizedWorkflowId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, safeLimit)
  }
  if (normalizedWorkflowId) {
    const rows = db.prepare(`
      SELECT * FROM ${WORKFLOW_RUNS_TABLE}
      WHERE workflow_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(normalizedWorkflowId, safeLimit) as Record<string, any>[]
    return rows.map(rowToRunRecord)
  }
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUNS_TABLE}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit) as Record<string, any>[]
  return rows.map(rowToRunRecord)
}

export function createWorkflowRunNodeSession(input: {
  id?: string
  run_id: string
  workflow_id: string
  node_id: string
  session_id: string
  profile?: string | null
  agent?: string | null
  agent_mode?: string | null
  status?: WorkflowRunNodeStatus
  sequence?: number
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}): WorkflowRunNodeSessionRecord {
  const now = Date.now()
  const record: WorkflowRunNodeSessionRecord = {
    id: input.id?.trim() || randomUUID(),
    run_id: input.run_id,
    workflow_id: input.workflow_id,
    node_id: input.node_id,
    session_id: input.session_id,
    profile: profileName(input.profile),
    agent: input.agent?.trim() || '',
    agent_mode: input.agent_mode?.trim() || '',
    status: input.status || 'queued',
    sequence: input.sequence || 0,
    started_at: input.started_at ?? null,
    finished_at: input.finished_at ?? null,
    created_at: now,
    updated_at: now,
    error: input.error || null,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id, record as any)
    return record
  }
  db.prepare(`
    INSERT INTO ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} (
      id, run_id, workflow_id, node_id, session_id, profile, agent, agent_mode,
      status, sequence, started_at, finished_at, created_at, updated_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.run_id,
    record.workflow_id,
    record.node_id,
    record.session_id,
    record.profile,
    record.agent,
    record.agent_mode,
    record.status,
    record.sequence,
    record.started_at,
    record.finished_at,
    record.created_at,
    record.updated_at,
    record.error,
  )
  return record
}

export function updateWorkflowRunNodeSession(id: string, patch: {
  status?: WorkflowRunNodeStatus
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}): WorkflowRunNodeSessionRecord | null {
  const existing = getWorkflowRunNodeSession(id)
  if (!existing) return null
  const next: WorkflowRunNodeSessionRecord = {
    ...existing,
    status: patch.status ?? existing.status,
    started_at: patch.started_at === undefined ? existing.started_at : patch.started_at,
    finished_at: patch.finished_at === undefined ? existing.finished_at : patch.finished_at,
    updated_at: Date.now(),
    error: patch.error === undefined ? existing.error : patch.error,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, id, next as any)
    return next
  }
  db.prepare(`
    UPDATE ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    SET status = ?, started_at = ?, finished_at = ?, updated_at = ?, error = ?
    WHERE id = ?
  `).run(next.status, next.started_at, next.finished_at, next.updated_at, next.error, id)
  return next
}

export function getWorkflowRunNodeSession(id: string): WorkflowRunNodeSessionRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, id)
    return row ? rowToNodeSessionRecord(row) : null
  }
  const row = db.prepare(`SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToNodeSessionRecord(row) : null
}

export function listWorkflowRunNodeSessions(runId: string): WorkflowRunNodeSessionRecord[] {
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE))
      .map(rowToNodeSessionRecord)
      .filter(record => record.run_id === runId)
      .sort((a, b) => a.sequence - b.sequence)
  }
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ?
    ORDER BY sequence ASC
  `).all(runId) as Record<string, any>[]
  return rows.map(rowToNodeSessionRecord)
}

export function deleteWorkflowRunNodeSessions(runId: string, nodeIds: string[]): WorkflowRunNodeSessionRecord[] {
  const normalizedRunId = runId.trim()
  const nodeIdSet = new Set(nodeIds.map(id => id.trim()).filter(Boolean))
  if (!normalizedRunId || nodeIdSet.size === 0) return []

  const db = getDb()
  if (!db) {
    const deleted: WorkflowRunNodeSessionRecord[] = []
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE)).map(rowToNodeSessionRecord)) {
      if (record.run_id !== normalizedRunId || !nodeIdSet.has(record.node_id)) continue
      deleted.push(record)
      jsonDelete(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id)
    }
    return deleted.sort((a, b) => a.sequence - b.sequence)
  }

  const placeholders = [...nodeIdSet].map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ? AND node_id IN (${placeholders})
    ORDER BY sequence ASC
  `).all(normalizedRunId, ...nodeIdSet) as Record<string, any>[]
  db.prepare(`
    DELETE FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ? AND node_id IN (${placeholders})
  `).run(normalizedRunId, ...nodeIdSet)
  return rows.map(rowToNodeSessionRecord)
}
