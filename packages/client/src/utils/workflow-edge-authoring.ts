export interface WorkflowAuthoringEdge {
  id?: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  type?: 'smoothstep' | 'workflow-self-loop'
  animated?: boolean
  data?: { orchestration?: { route?: 'success' | 'failure' | 'always'; feedback?: unknown } }
}

export interface WorkflowAuthoringConnection {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export type WorkflowHandleId = 'input' | 'top' | 'output' | 'bottom'
export type WorkflowHandleType = 'source' | 'target'
export type WorkflowHandlePosition = 'left' | 'top' | 'right' | 'bottom'
export type WorkflowAuthoringLoopErrorType =
  | 'feedback_without_forward_path'
  | 'feedback_not_natural_loop'
  | 'duplicate_loop_id'
  | 'identical_loop_bodies'
  | 'partially_overlapping_loop_bodies'

export interface WorkflowAuthoringLoopError {
  type: WorkflowAuthoringLoopErrorType
  edgeIds: string[]
}

const workflowHandleIds = new Set<WorkflowHandleId>(['input', 'top', 'output', 'bottom'])

export function normalizeWorkflowHandleId(handleId: string | null | undefined, type: WorkflowHandleType): WorkflowHandleId {
  return workflowHandleIds.has(handleId as WorkflowHandleId)
    ? handleId as WorkflowHandleId
    : type === 'source' ? 'output' : 'input'
}

export function workflowConnectionIsValid(connection: WorkflowAuthoringConnection): boolean {
  if (!connection.source || !connection.target) return false
  const sourceHandle = normalizeWorkflowHandleId(connection.sourceHandle, 'source')
  const targetHandle = normalizeWorkflowHandleId(connection.targetHandle, 'target')
  return connection.source !== connection.target || sourceHandle !== targetHandle
}

function forwardAdjacency(
  nodeIds: string[],
  edges: WorkflowAuthoringEdge[],
  ignoredEdgeId?: string,
): { outgoing: Map<string, string[]>; incoming: Map<string, string[]> } {
  const nodeSet = new Set(nodeIds)
  const outgoing = new Map(nodeIds.map(id => [id, [] as string[]]))
  const incoming = new Map(nodeIds.map(id => [id, [] as string[]]))
  for (const edge of edges) {
    if (edge.id === ignoredEdgeId || edge.data?.orchestration?.feedback) continue
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
  }
  return { outgoing, incoming }
}

function reachableFrom(start: string, adjacency: Map<string, string[]>): Set<string> {
  const visited = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const nodeId = stack.pop()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    for (const nextId of adjacency.get(nodeId) || []) stack.push(nextId)
  }
  return visited
}

export function workflowEdgeClosesCycle(
  source: string,
  target: string,
  edges: WorkflowAuthoringEdge[],
  ignoredEdgeId?: string,
): boolean {
  if (!source || !target) return false
  if (source === target) return true
  const nodeIds = [...new Set(edges.flatMap(edge => [edge.source, edge.target]).concat(source, target))]
  const { outgoing } = forwardAdjacency(nodeIds, edges, ignoredEdgeId)
  return reachableFrom(target, outgoing).has(source)
}

export function workflowLoopBodyNodeIds(
  nodeIds: string[],
  source: string,
  target: string,
  edges: WorkflowAuthoringEdge[],
  ignoredEdgeId?: string,
): string[] {
  if (source === target) return nodeIds.includes(source) ? [source] : []
  const { outgoing, incoming } = forwardAdjacency(nodeIds, edges, ignoredEdgeId)
  const reachableFromHeader = reachableFrom(target, outgoing)
  const canReachLatch = reachableFrom(source, incoming)
  return nodeIds.filter(nodeId => reachableFromHeader.has(nodeId) && canReachLatch.has(nodeId))
}

export function workflowEdgeVisualType(source: string, target: string): 'smoothstep' | 'workflow-self-loop' {
  return source === target ? 'workflow-self-loop' : 'smoothstep'
}

export function createWorkflowAuthoringEdge(
  connection: WorkflowAuthoringConnection,
  edges: WorkflowAuthoringEdge[],
): WorkflowAuthoringEdge {
  const sourceHandle = normalizeWorkflowHandleId(connection.sourceHandle, 'source')
  const targetHandle = normalizeWorkflowHandleId(connection.targetHandle, 'target')
  const feedback = workflowEdgeClosesCycle(connection.source, connection.target, edges)
  return {
    id: `${connection.source}-${connection.target}`,
    source: connection.source,
    target: connection.target,
    sourceHandle,
    targetHandle,
    type: workflowEdgeVisualType(connection.source, connection.target),
    animated: false,
    data: {
      orchestration: {
        route: 'success',
        ...(feedback ? { feedback: { maxIterations: 3 } } : {}),
      },
    },
  }
}

export function workflowSelfLoopPath(input: {
  sourceX: number
  sourceY: number
  sourcePosition: WorkflowHandlePosition
  targetX: number
  targetY: number
  targetPosition: WorkflowHandlePosition
  nodeBounds: { left: number; top: number; right: number; bottom: number }
}): string {
  const margin = 80
  const outer = {
    left: input.nodeBounds.left - margin,
    top: input.nodeBounds.top - margin,
    right: input.nodeBounds.right + margin,
    bottom: input.nodeBounds.bottom + margin,
  }
  const sourceOuter = input.sourcePosition === 'left'
    ? { x: outer.left, y: input.sourceY }
    : input.sourcePosition === 'right'
      ? { x: outer.right, y: input.sourceY }
      : input.sourcePosition === 'top'
        ? { x: input.sourceX, y: outer.top }
        : { x: input.sourceX, y: outer.bottom }
  const targetOuter = input.targetPosition === 'left'
    ? { x: outer.left, y: input.targetY }
    : input.targetPosition === 'right'
      ? { x: outer.right, y: input.targetY }
      : input.targetPosition === 'top'
        ? { x: input.targetX, y: outer.top }
        : { x: input.targetX, y: outer.bottom }
  const oppositeHorizontal = (
    input.sourcePosition === 'left' && input.targetPosition === 'right'
  ) || (
    input.sourcePosition === 'right' && input.targetPosition === 'left'
  )
  if (oppositeHorizontal) {
    return [
      `M ${input.sourceX} ${input.sourceY}`,
      `L ${sourceOuter.x} ${sourceOuter.y}`,
      `L ${sourceOuter.x} ${outer.top}`,
      `L ${targetOuter.x} ${outer.top}`,
      `L ${targetOuter.x} ${targetOuter.y}`,
      `L ${input.targetX} ${input.targetY}`,
    ].join(' ')
  }

  const oppositeVertical = (
    input.sourcePosition === 'top' && input.targetPosition === 'bottom'
  ) || (
    input.sourcePosition === 'bottom' && input.targetPosition === 'top'
  )
  if (oppositeVertical) {
    return [
      `M ${input.sourceX} ${input.sourceY}`,
      `L ${sourceOuter.x} ${sourceOuter.y}`,
      `L ${outer.right} ${sourceOuter.y}`,
      `L ${outer.right} ${targetOuter.y}`,
      `L ${targetOuter.x} ${targetOuter.y}`,
      `L ${input.targetX} ${input.targetY}`,
    ].join(' ')
  }

  const sourceIsHorizontal = input.sourcePosition === 'left' || input.sourcePosition === 'right'
  const cornerX = sourceIsHorizontal ? sourceOuter.x : targetOuter.x
  const cornerY = sourceIsHorizontal ? targetOuter.y : sourceOuter.y
  return [
    `M ${input.sourceX} ${input.sourceY}`,
    `L ${sourceOuter.x} ${sourceOuter.y}`,
    `L ${cornerX} ${cornerY}`,
    `L ${targetOuter.x} ${targetOuter.y}`,
    `L ${input.targetX} ${input.targetY}`,
  ].join(' ')
}

function workflowFeedbackConfig(edge: WorkflowAuthoringEdge): { loopId?: string } | null {
  const feedback = edge.data?.orchestration?.feedback
  if (!feedback || typeof feedback !== 'object') return null
  const loopId = typeof (feedback as Record<string, unknown>).loopId === 'string'
    ? String((feedback as Record<string, unknown>).loopId).trim()
    : ''
  return loopId ? { loopId } : {}
}

function setContains(outer: Set<string>, inner: Set<string>): boolean {
  return [...inner].every(nodeId => outer.has(nodeId))
}

function workflowForwardDominators(
  nodeIds: string[],
  edges: WorkflowAuthoringEdge[],
): Map<string, Set<string>> {
  const { outgoing, incoming } = forwardAdjacency(nodeIds, edges)
  const indegree = new Map(nodeIds.map(nodeId => [nodeId, incoming.get(nodeId)?.length || 0]))
  const queue = nodeIds.filter(nodeId => indegree.get(nodeId) === 0)
  const topological: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]
    topological.push(nodeId)
    for (const targetId of outgoing.get(nodeId) || []) {
      indegree.set(targetId, indegree.get(targetId)! - 1)
      if (indegree.get(targetId) === 0) queue.push(targetId)
    }
  }

  const dominators = new Map<string, Set<string>>()
  for (const nodeId of topological) {
    const predecessors = incoming.get(nodeId) || []
    if (predecessors.length === 0) {
      dominators.set(nodeId, new Set([nodeId]))
      continue
    }
    const intersection = new Set(dominators.get(predecessors[0]) || [])
    for (const predecessorId of predecessors.slice(1)) {
      const candidate = dominators.get(predecessorId) || new Set<string>()
      for (const value of intersection) if (!candidate.has(value)) intersection.delete(value)
    }
    intersection.add(nodeId)
    dominators.set(nodeId, intersection)
  }
  return dominators
}

export function validateWorkflowAuthoringLoops(
  nodeIds: string[],
  edges: WorkflowAuthoringEdge[],
): WorkflowAuthoringLoopError | null {
  const feedbackEdges = edges.filter(edge => workflowFeedbackConfig(edge) !== null)
  const dominators = workflowForwardDominators(nodeIds, edges)
  const loopIds = new Map<string, string>()
  for (const edge of feedbackEdges) {
    const loopId = workflowFeedbackConfig(edge)?.loopId
    const edgeId = edge.id || `${edge.source}-${edge.target}`
    if (!loopId) continue
    const existingEdgeId = loopIds.get(loopId)
    if (existingEdgeId) return { type: 'duplicate_loop_id', edgeIds: [existingEdgeId, edgeId] }
    loopIds.set(loopId, edgeId)
  }

  const loops: Array<{ edgeId: string; body: Set<string> }> = []
  for (const edge of feedbackEdges) {
    const edgeId = edge.id || `${edge.source}-${edge.target}`
    const bodyNodeIds = workflowLoopBodyNodeIds(nodeIds, edge.source, edge.target, edges, edge.id)
    const body = new Set(bodyNodeIds)
    if (!body.has(edge.source) || !body.has(edge.target)) {
      return { type: 'feedback_without_forward_path', edgeIds: [edgeId] }
    }
    if (!dominators.get(edge.source)?.has(edge.target)) {
      return { type: 'feedback_not_natural_loop', edgeIds: [edgeId] }
    }
    loops.push({ edgeId, body })
  }

  for (let leftIndex = 0; leftIndex < loops.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < loops.length; rightIndex += 1) {
      const left = loops[leftIndex]
      const right = loops[rightIndex]
      const overlap = [...left.body].some(nodeId => right.body.has(nodeId))
      if (!overlap) continue
      const leftContainsRight = setContains(left.body, right.body)
      const rightContainsLeft = setContains(right.body, left.body)
      if (leftContainsRight && rightContainsLeft) {
        return { type: 'identical_loop_bodies', edgeIds: [left.edgeId, right.edgeId] }
      }
      if (!leftContainsRight && !rightContainsLeft) {
        return { type: 'partially_overlapping_loop_bodies', edgeIds: [left.edgeId, right.edgeId] }
      }
    }
  }
  return null
}
