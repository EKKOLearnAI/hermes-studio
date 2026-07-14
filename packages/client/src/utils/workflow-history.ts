import type { WorkflowRunNodeSessionRecord, WorkflowRunRecord } from '@/api/hermes/workflows'

export type WorkflowEvidenceKind = 'node' | 'edge' | 'loop'
export interface WorkflowEvidenceRow {
  kind: WorkflowEvidenceKind
  sequence: number
  technicalId: string
  status: string
  iterationPath: string
  nodeTitle?: string
  sourceTitle?: string
  targetTitle?: string
  route?: string
  reason?: string | null
  iteration?: number
  exitReason?: string | null
  error?: string | null
}

export function formatIterationPath(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return '—'
  const values = raw.map(item => item && typeof item === 'object' ? item as Record<string, unknown> : {})
  const scopes = [...new Set(values.flatMap(value => typeof value.executionScope === 'string' ? [value.executionScope] : []))]
  const path = values.flatMap(value => {
    if (typeof value.loopId !== 'string') return []
    const iteration = Number.isInteger(value.iteration) ? Number(value.iteration) + 1 : '?'
    return [`${value.loopId}#${iteration}`]
  }).join(' / ')
  if (scopes.length > 0 && path) return `${scopes.join(' / ')} · ${path}`
  return scopes.length > 0 ? scopes.join(' / ') : path || '—'
}

export function latestWorkflowNodeSession(
  sessions: WorkflowRunNodeSessionRecord[] | undefined,
  nodeId: string,
): WorkflowRunNodeSessionRecord | undefined {
  return (sessions || []).reduce<WorkflowRunNodeSessionRecord | undefined>((latest, session) => {
    if (session.node_id !== nodeId) return latest
    if (!latest || session.sequence > latest.sequence) return session
    return latest
  }, undefined)
}

function workflowNodeTitleMap(snapshotNodes: unknown[] | undefined): Map<string, string> {
  const titles = new Map<string, string>()
  for (const raw of snapshotNodes || []) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as Record<string, unknown>
    if (typeof node.id !== 'string') continue
    const data = node.data && typeof node.data === 'object' ? node.data as Record<string, unknown> : {}
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : node.id
    titles.set(node.id, title)
  }
  return titles
}

export function buildWorkflowEvidenceRows(run: Pick<WorkflowRunRecord, 'snapshot_nodes' | 'node_sessions' | 'edge_evaluations' | 'loop_epochs'>): WorkflowEvidenceRow[] {
  const rows: WorkflowEvidenceRow[] = []
  const nodeTitles = workflowNodeTitleMap(run.snapshot_nodes)
  const nodeTitle = (nodeId: string) => nodeTitles.get(nodeId) || nodeId
  const exceptionalNodeStatuses = new Set(['failed', 'blocked', 'approval_rejected', 'canceled'])
  for (const node of run.node_sessions || []) {
    if (!exceptionalNodeStatuses.has(node.status)) continue
    rows.push({
      kind: 'node', sequence: node.sequence, technicalId: node.execution_id, status: node.status,
      nodeTitle: nodeTitle(node.node_id), error: node.error, iterationPath: formatIterationPath(node.iteration_path),
    })
  }
  for (const edge of run.edge_evaluations || []) rows.push({
    kind: 'edge', sequence: edge.sequence, technicalId: edge.edge_id, status: edge.status,
    sourceTitle: nodeTitle(edge.source_node_id), targetTitle: nodeTitle(edge.target_node_id), route: edge.route, reason: edge.reason,
    iterationPath: formatIterationPath(edge.iteration_path),
  })
  for (const loop of run.loop_epochs || []) rows.push({
    kind: 'loop', sequence: loop.sequence, technicalId: loop.loop_id, status: loop.status,
    iteration: loop.iteration, exitReason: loop.exit_reason, iterationPath: formatIterationPath(loop.iteration_path),
  })
  return rows.sort((a, b) => a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.technicalId.localeCompare(b.technicalId))
}
