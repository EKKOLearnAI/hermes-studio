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
  sourceOutcome?: string
  conditionPath?: string
  conditionOperator?: string
  expectedValue?: string
  actualValue?: string
  businessDecision?: string
  businessReason?: string
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boundedSummaryText(value: unknown, maxLength = 600): string | undefined {
  const raw = nonEmptyText(value)
  if (!raw) return undefined
  const normalized = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === 'string') return boundedSummaryText(value, 240)
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized
  } catch {
    return String(value)
  }
}

function parseBusinessResult(value: unknown): Record<string, unknown> | null {
  const direct = recordValue(value)
  if (direct) return direct
  if (typeof value !== 'string') return null
  const candidates: string[] = []
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const trimmed = value.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed)
  const firstBrace = value.indexOf('{')
  const lastBrace = value.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(value.slice(firstBrace, lastBrace + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const record = recordValue(parsed)
      if (record) return record
    } catch {
      // Keep the raw condition value when the output is not JSON.
    }
  }
  return null
}

function businessReason(result: Record<string, unknown> | null): string | undefined {
  if (!result) return undefined
  const direct = boundedSummaryText(result.reason) || boundedSummaryText(result.message) || boundedSummaryText(result.error)
  if (direct) return direct
  if (Array.isArray(result.blocking_reasons)) {
    const reasons = result.blocking_reasons
      .map(item => boundedSummaryText(item, 200))
      .filter((item): item is string => Boolean(item))
    if (reasons.length > 0) return boundedSummaryText(reasons.join('; '))
  }
  return undefined
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
  for (const edge of run.edge_evaluations || []) {
    const orchestration = recordValue(edge.orchestration)
    const condition = recordValue(orchestration?.condition)
    const evaluation = recordValue(edge.condition_evaluation)
    const actual = evaluation?.actual
    const result = parseBusinessResult(actual)
    const decision = boundedSummaryText(result?.decision, 80)
    const routeMarker = boundedSummaryText(result?.route_marker, 80)
    rows.push({
      kind: 'edge', sequence: edge.sequence, technicalId: edge.edge_id, status: edge.status,
      sourceTitle: nodeTitle(edge.source_node_id), targetTitle: nodeTitle(edge.target_node_id),
      route: edge.route, reason: edge.reason, sourceOutcome: edge.source_outcome,
      conditionPath: nonEmptyText(condition?.path), conditionOperator: nonEmptyText(condition?.operator),
      expectedValue: displayValue(condition?.value),
      actualValue: routeMarker || decision || displayValue(actual),
      businessDecision: decision,
      businessReason: businessReason(result),
      iterationPath: formatIterationPath(edge.iteration_path),
    })
  }
  for (const loop of run.loop_epochs || []) rows.push({
    kind: 'loop', sequence: loop.sequence, technicalId: loop.loop_id, status: loop.status,
    iteration: loop.iteration, exitReason: loop.exit_reason, iterationPath: formatIterationPath(loop.iteration_path),
  })
  return rows.sort((a, b) => a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.technicalId.localeCompare(b.technicalId))
}
