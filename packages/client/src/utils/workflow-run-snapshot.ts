import { MarkerType, type EdgeMarkerType } from '@vue-flow/core'
import { normalizeWorkflowHandleId, workflowEdgeVisualType } from './workflow-edge-authoring'

export interface WorkflowRunEdgeOrchestration {
  route: 'success' | 'failure' | 'always'
  condition?: { path: string; operator: string; value?: unknown }
  feedback?: { maxIterations: number; loopId?: string }
}

export interface WorkflowRunPlaybackEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  type: 'smoothstep' | 'workflow-self-loop'
  animated: boolean
  markerEnd: EdgeMarkerType
  label?: string
  data?: { orchestration?: WorkflowRunEdgeOrchestration; [key: string]: unknown }
}

export function normalizeWorkflowRunEdge(raw: unknown): WorkflowRunPlaybackEdge | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  if (typeof record.source !== 'string' || typeof record.target !== 'string') return null
  const authoredData = record.data && typeof record.data === 'object' ? { ...record.data } : undefined
  const legacyOrchestration = record.orchestration && typeof record.orchestration === 'object'
    ? { ...record.orchestration } as WorkflowRunEdgeOrchestration
    : undefined
  const data = authoredData?.orchestration || !legacyOrchestration
    ? authoredData
    : { ...(authoredData || {}), orchestration: legacyOrchestration }
  return {
    id: typeof record.id === 'string' && record.id ? record.id : `${record.source}-${record.target}`,
    source: record.source,
    target: record.target,
    sourceHandle: normalizeWorkflowHandleId(record.sourceHandle, 'source'),
    targetHandle: normalizeWorkflowHandleId(record.targetHandle, 'target'),
    type: workflowEdgeVisualType(record.source, record.target),
    animated: Boolean(record.animated),
    markerEnd: MarkerType.ArrowClosed,
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
    data,
  }
}
