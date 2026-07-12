export type WorkflowRoute = 'success' | 'failure' | 'always'
export type WorkflowJoinMode = 'all' | 'any'
export type WorkflowConditionOperator = 'equals' | 'not_equals' | 'exists' | 'truthy' | 'contains'

export interface WorkflowCondition {
  path: string
  operator: WorkflowConditionOperator
  value?: unknown
}

export interface WorkflowEdgePolicy {
  route: WorkflowRoute
  condition?: WorkflowCondition
  loop?: { maxIterations: number }
}

export interface WorkflowEdgeLike {
  id?: string
  source?: string
  target?: string
  data?: unknown
}

export interface WorkflowNodeLike {
  id?: string
  data?: unknown
}

export interface WorkflowNodeOutcome {
  nodeId: string
  status: 'success' | 'failure'
  output?: string | null
  error?: string | null
}

export interface WorkflowEdgeEvaluation {
  status: 'taken' | 'not_taken' | 'error'
  reason: string
}

export interface CompiledWorkflowEdge {
  id: string
  source: string
  target: string
  policy: WorkflowEdgePolicy
  loopNodeIds?: string[]
  loopOrder?: number
}

export interface CompiledWorkflowNode {
  id: string
  joinMode: WorkflowJoinMode
}

const ROUTES = new Set<WorkflowRoute>(['success', 'failure', 'always'])
const OPERATORS = new Set<WorkflowConditionOperator>(['equals', 'not_equals', 'exists', 'truthy', 'contains'])
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
export const MAX_WORKFLOW_LOOP_ITERATIONS = 100

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeCondition(value: unknown): WorkflowCondition {
  const source = record(value)
  if (!source) throw new Error('workflow condition must be an object')
  const path = typeof source.path === 'string' ? source.path.trim() : ''
  const segments = path.split('.')
  if (!path || segments.some(segment => !segment || FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    throw new Error('workflow condition path is invalid')
  }
  if (!OPERATORS.has(source.operator as WorkflowConditionOperator)) {
    throw new Error('workflow condition operator is invalid')
  }
  const operator = source.operator as WorkflowConditionOperator
  if (['equals', 'not_equals', 'contains'].includes(operator) && !Object.prototype.hasOwnProperty.call(source, 'value')) {
    throw new Error(`workflow condition ${operator} requires value`)
  }
  return Object.prototype.hasOwnProperty.call(source, 'value')
    ? { path, operator, value: source.value }
    : { path, operator }
}

export function normalizeWorkflowEdgePolicy(value: unknown): WorkflowEdgePolicy {
  if (value === undefined) return { route: 'success' }
  const source = record(value)
  if (!source) throw new Error('workflow edge orchestration must be an object')
  if (!ROUTES.has(source.route as WorkflowRoute)) throw new Error('workflow edge route is invalid')
  const policy: WorkflowEdgePolicy = { route: source.route as WorkflowRoute }
  if (Object.prototype.hasOwnProperty.call(source, 'condition')) {
    policy.condition = normalizeCondition(source.condition)
  }
  if (Object.prototype.hasOwnProperty.call(source, 'loop')) {
    const loop = record(source.loop)
    if (!loop) throw new Error('workflow edge loop must be an object')
    if (Object.keys(loop).some(key => key !== 'maxIterations')) throw new Error('workflow edge loop has unknown fields')
    if (!policy.condition) throw new Error('workflow edge loop requires a condition')
    const maxIterations = loop.maxIterations
    if (!Number.isInteger(maxIterations) || (maxIterations as number) < 1 || (maxIterations as number) > MAX_WORKFLOW_LOOP_ITERATIONS) {
      throw new Error(`workflow edge loop maxIterations must be an integer from 1 to ${MAX_WORKFLOW_LOOP_ITERATIONS}`)
    }
    policy.loop = { maxIterations: maxIterations as number }
  }
  return policy
}

export function normalizeWorkflowJoinMode(value: unknown): WorkflowJoinMode {
  if (value === undefined) return 'all'
  if (value !== 'all' && value !== 'any') throw new Error('workflow joinMode must be all or any')
  return value
}

export function parseWorkflowJsonOutput(output: unknown): unknown | null {
  if (typeof output !== 'string') return null
  const text = output.trim()
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i)
  const candidate = fenced?.[1]?.trim() || text
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function readOwnPath(root: unknown, path: string): { found: boolean; value: unknown } {
  const segments = path.split('.')
  let current = root
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) throw new Error('workflow condition path is invalid')
    const source = record(current)
    if (!source || !Object.prototype.hasOwnProperty.call(source, segment)) return { found: false, value: undefined }
    current = source[segment]
  }
  return { found: true, value: current }
}

function conditionMatches(condition: WorkflowCondition, outcome: WorkflowNodeOutcome): boolean {
  const output = typeof outcome.output === 'string' ? outcome.output : ''
  const parsedJson = parseWorkflowJsonOutput(output)
  const path = condition.path.startsWith('json.') || condition.path === 'json'
    ? condition.path
    : `json.${condition.path}`
  if ((path === 'json' || path.startsWith('json.')) && parsedJson === null && output.trim() !== 'null') {
    throw new Error('workflow condition requires valid JSON output')
  }
  const context: Record<string, unknown> = {
    status: outcome.status,
    output,
    error: outcome.error ?? null,
    json: parsedJson,
  }
  const actual = readOwnPath(context, path)
  switch (condition.operator) {
    case 'exists': return actual.found
    case 'truthy': return actual.found && Boolean(actual.value)
    case 'equals': return actual.found && Object.is(actual.value, condition.value)
    case 'not_equals': return actual.found && !Object.is(actual.value, condition.value)
    case 'contains':
      return actual.found && (
        (Array.isArray(actual.value) && actual.value.includes(condition.value))
        || (typeof actual.value === 'string' && typeof condition.value === 'string' && actual.value.includes(condition.value))
      )
  }
}

export function evaluateWorkflowEdge(edge: WorkflowEdgeLike, outcome: WorkflowNodeOutcome): WorkflowEdgeEvaluation {
  try {
    const data = record(edge.data)
    const policy = normalizeWorkflowEdgePolicy(data?.orchestration)
    if (policy.route !== 'always' && policy.route !== outcome.status) {
      return { status: 'not_taken', reason: `route ${policy.route} does not match ${outcome.status}` }
    }
    if (!policy.condition) return { status: 'taken', reason: 'route matched' }
    return conditionMatches(policy.condition, outcome)
      ? { status: 'taken', reason: 'condition matched' }
      : { status: 'not_taken', reason: 'condition did not match' }
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

export function compileWorkflowGraph(nodesInput: unknown[], edgesInput: unknown[]): {
  nodes: CompiledWorkflowNode[]
  edges: CompiledWorkflowEdge[]
} {
  const nodes: CompiledWorkflowNode[] = []
  const nodeIds = new Set<string>()
  for (const raw of nodesInput) {
    const source = record(raw)
    const id = typeof source?.id === 'string' ? source.id.trim() : ''
    if (!id) throw new Error('workflow node id is required')
    if (nodeIds.has(id)) throw new Error(`duplicate node id: ${id}`)
    nodeIds.add(id)
    const data = record(source?.data)
    const orchestration = data && Object.prototype.hasOwnProperty.call(data, 'orchestration')
      ? record(data.orchestration)
      : null
    if (data?.orchestration !== undefined && !orchestration) throw new Error('node orchestration must be an object')
    nodes.push({ id, joinMode: normalizeWorkflowJoinMode(orchestration?.joinMode) })
  }

  const edges: CompiledWorkflowEdge[] = []
  const edgeIds = new Set<string>()
  edgesInput.forEach((raw, index) => {
    const source = record(raw)
    const from = typeof source?.source === 'string' ? source.source.trim() : ''
    const to = typeof source?.target === 'string' ? source.target.trim() : ''
    if (!nodeIds.has(from)) throw new Error(`workflow edge has missing source: ${from}`)
    if (!nodeIds.has(to)) throw new Error(`workflow edge has missing target: ${to}`)
    if (from === to) throw new Error(`workflow graph contains self-loop: ${from}`)
    const id = typeof source?.id === 'string' && source.id.trim() ? source.id.trim() : `${from}->${to}#${index}`
    if (edgeIds.has(id)) throw new Error(`duplicate edge id: ${id}`)
    edgeIds.add(id)
    const data = record(source?.data)
    edges.push({ id, source: from, target: to, policy: normalizeWorkflowEdgePolicy(data?.orchestration) })
  })

  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]))
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  for (const edge of edges) {
    if (edge.policy.loop) continue
    outgoing.get(edge.source)!.push(edge.target)
    indegree.set(edge.target, indegree.get(edge.target)! + 1)
  }
  const ready = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  let visited = 0
  while (ready.length) {
    const id = ready.shift()!
    visited += 1
    for (const target of outgoing.get(id) || []) {
      const next = indegree.get(target)! - 1
      indegree.set(target, next)
      if (next === 0) ready.push(target)
    }
  }
  if (visited !== nodes.length) throw new Error('workflow graph contains a cycle')

  for (const edge of edges) {
    if (!edge.policy.loop) continue
    const pending = [edge.target]
    const reachable = new Set<string>()
    while (pending.length) {
      const nodeId = pending.pop()!
      if (reachable.has(nodeId)) continue
      reachable.add(nodeId)
      for (const target of outgoing.get(nodeId) || []) pending.push(target)
    }
    if (!reachable.has(edge.source)) {
      throw new Error(`workflow feedback edge does not close a forward path: ${edge.id}`)
    }
    const reverse = new Map(nodes.map(node => [node.id, [] as string[]]))
    for (const [from, targets] of outgoing) {
      for (const target of targets) reverse.get(target)!.push(from)
    }
    const canReachSource = new Set<string>()
    const reversePending = [edge.source]
    while (reversePending.length) {
      const nodeId = reversePending.pop()!
      if (canReachSource.has(nodeId)) continue
      canReachSource.add(nodeId)
      for (const predecessor of reverse.get(nodeId) || []) reversePending.push(predecessor)
    }
    const loopNodeIds = nodes
      .map(node => node.id)
      .filter(nodeId => reachable.has(nodeId) && canReachSource.has(nodeId))
    const loopNodes = new Set(loopNodeIds)
    for (const candidate of edges) {
      if (candidate.policy.loop || candidate.target === edge.target || !loopNodes.has(candidate.target)) continue
      if (!loopNodes.has(candidate.source)) {
        throw new Error(`workflow feedback region must be single-entry: ${edge.id}`)
      }
    }
    edge.loopNodeIds = loopNodeIds
  }
  const loopEdges = edges.filter(edge => edge.policy.loop)
  for (let leftIndex = 0; leftIndex < loopEdges.length; leftIndex += 1) {
    const left = new Set(loopEdges[leftIndex].loopNodeIds || [])
    for (let rightIndex = leftIndex + 1; rightIndex < loopEdges.length; rightIndex += 1) {
      const right = new Set(loopEdges[rightIndex].loopNodeIds || [])
      const intersects = [...left].some(nodeId => right.has(nodeId))
      if (!intersects) continue
      const leftContainsRight = [...right].every(nodeId => left.has(nodeId))
      const rightContainsLeft = [...left].every(nodeId => right.has(nodeId))
      if ((leftContainsRight && rightContainsLeft) || (!leftContainsRight && !rightContainsLeft)) {
        throw new Error(`workflow feedback regions overlap ambiguously: ${loopEdges[leftIndex].id}, ${loopEdges[rightIndex].id}`)
      }
    }
  }
  loopEdges
    .slice()
    .sort((left, right) =>
      (right.loopNodeIds?.length || 0) - (left.loopNodeIds?.length || 0) || left.id.localeCompare(right.id),
    )
    .forEach((edge, index) => { edge.loopOrder = index })
  return { nodes, edges }
}
