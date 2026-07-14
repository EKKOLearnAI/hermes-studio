import type { WorkflowRunNodeSessionRecord, WorkflowRunRecord } from '@/api/hermes/workflows'

export type WorkflowEvidenceKind = 'node' | 'edge' | 'loop'
export interface WorkflowEvidenceRow {
  kind: WorkflowEvidenceKind
  sequence: number
  title: string
  status: string
  detail: string
  iterationPath: string
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

export function buildWorkflowEvidenceRows(run: Pick<WorkflowRunRecord, 'node_sessions' | 'edge_evaluations' | 'loop_epochs'>): WorkflowEvidenceRow[] {
  const rows: WorkflowEvidenceRow[] = []
  const exceptionalNodeStatuses = new Set(['failed', 'blocked', 'approval_rejected', 'canceled'])
  for (const node of run.node_sessions || []) {
    if (!exceptionalNodeStatuses.has(node.status)) continue
    rows.push({
      kind: 'node', sequence: node.sequence, title: node.execution_id, status: node.status,
      detail: [node.error || node.node_id, node.consumed_edge_evaluation_ids?.length ? `consumed: ${node.consumed_edge_evaluation_ids.join(', ')}` : ''].filter(Boolean).join(' · '), iterationPath: formatIterationPath(node.iteration_path),
    })
  }
  for (const edge of run.edge_evaluations || []) rows.push({
    kind: 'edge', sequence: edge.sequence, title: edge.edge_id, status: edge.status,
    detail: `${edge.source_execution_id} → ${edge.target_node_id} · ${edge.route}${edge.reason ? ` · ${edge.reason}` : ''}`,
    iterationPath: formatIterationPath(edge.iteration_path),
  })
  for (const loop of run.loop_epochs || []) rows.push({
    kind: 'loop', sequence: loop.sequence, title: loop.loop_id, status: loop.status,
    detail: `#${loop.iteration + 1}${loop.exit_reason ? ` · ${loop.exit_reason}` : ''}`,
    iterationPath: formatIterationPath(loop.iteration_path),
  })
  return rows.sort((a, b) => a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
}
