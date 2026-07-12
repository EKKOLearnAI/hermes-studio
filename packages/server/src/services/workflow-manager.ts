import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowCreateInput,
  type WorkflowRecord,
  type WorkflowUpdateInput,
} from '../db/hermes/workflow-store'
import { getExactSessionDetailFromDbWithProfile } from '../db/hermes/sessions-db'
import {
  createWorkflowRun,
  createWorkflowRunEdgeEvaluation,
  createWorkflowRunNodeSession,
  deleteWorkflowRun,
  deleteWorkflowRunNodeSessions,
  getWorkflowRun,
  listWorkflowRunNodeSessions,
  listWorkflowRuns,
  recoverInterruptedWorkflowRuns,
  updateWorkflowRun,
  updateWorkflowRunNodeSession,
  type WorkflowRunNodeSessionRecord,
  type WorkflowRunRecord,
} from '../db/hermes/workflow-run-store'
import { deleteSession, getSession, getSessionDetail } from '../db/hermes/session-store'
import { getChatRunServer } from '../routes/hermes/chat-run'
import type { ContentBlock } from './hermes/run-chat'
import type { AuthenticatedUser } from '../middleware/user-auth'
import { resolveWorkflowSkillContent } from './workflow-skill-resolver'
import { codingAgentRunManager } from './agent-runner/coding-agent-run-manager'
import { deleteSessionForProfile } from './hermes/hermes-cli'
import { listProfileNamesFromDisk } from './hermes/hermes-profile'
import { logger } from './logger'
import { compileWorkflowGraph, evaluateWorkflowEdge, type WorkflowEdgeEvaluation } from './workflow-orchestration'

export type { WorkflowCreateInput, WorkflowRecord, WorkflowUpdateInput }

export type WorkflowRuntimeState = 'idle' | 'queued' | 'running' | 'pending_approval' | 'completed' | 'failed' | 'approval_rejected' | 'canceled' | 'skipped'
export type WorkflowRunType = 'workflow'
export type WorkflowNodeAgent = 'hermes' | 'claude-code' | 'codex'
const DEFAULT_WORKFLOW_TOTAL_TIMEOUT_MS = 3_600_000
const MAX_WORKFLOW_TOTAL_TIMEOUT_MS = 86_400_000
const DEFAULT_WORKFLOW_EXECUTION_BUDGET = 1_000
const MAX_WORKFLOW_EXECUTION_BUDGET = 10_000

export interface WorkflowNodeRunTarget {
  type: WorkflowRunType
  source: 'workflow'
  agent: 'hermes' | 'claude' | 'codex'
  codingAgentId?: 'claude-code' | 'codex'
}

export interface WorkflowRuntimeStatus {
  workflowId: string
  status: WorkflowRuntimeState
  runId: string | null
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
  error: string | null
  nodeStatuses: Record<string, WorkflowRuntimeState>
}

export interface WorkflowRunNowInput {
  profile?: string | null
  startNodeIds?: string[]
  input?: string | null
  user?: AuthenticatedUser
  timeoutMs?: number
  totalTimeoutMs?: number
  executionBudget?: number
}

export interface WorkflowRerunFromNodeInput {
  profile?: string | null
  preserveStartNode?: boolean
  user?: AuthenticatedUser
  timeoutMs?: number
}

export interface WorkflowRunNowResult {
  run: WorkflowRunRecord
  nodeSessions: WorkflowRunNodeSessionRecord[]
}

interface WorkflowNodeSnapshot {
  id: string
  type: string
  data: {
    title: string
    agent: string
    provider: string
    model: string
    apiMode: string
    reasoningEffort: string
    input: string
    skills: string[]
    images: string[]
    approvalRequired: boolean
    executionPolicy?: {
      allowedToolsets?: string[]
      allowedTools?: string[]
      skipMemory?: boolean
      skipContextFiles?: boolean
    }
  }
}

interface WorkflowEdgeSnapshot {
  id?: string
  source: string
  target: string
  data?: unknown
}

type WorkflowManagerEvents = {
  status: [WorkflowRuntimeStatus]
}

type WorkflowStatusListener = (status: WorkflowRuntimeStatus) => void

type PendingNodeApproval = {
  workflowId: string
  runId: string
  nodeId: string
  resolve: (approved: boolean) => void
}

function idleStatus(workflowId: string): WorkflowRuntimeStatus {
  return {
    workflowId,
    status: 'idle',
    runId: null,
    startedAt: null,
    updatedAt: Date.now(),
    completedAt: null,
    error: null,
    nodeStatuses: {},
  }
}

export function resolveWorkflowNodeRunTarget(agent?: string | null): WorkflowNodeRunTarget {
  if (agent === 'claude-code') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'claude',
      codingAgentId: 'claude-code',
    }
  }
  if (agent === 'codex') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'codex',
      codingAgentId: 'codex',
    }
  }
  return {
    type: 'workflow',
    source: 'workflow',
    agent: 'hermes',
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []
}

function normalizeExecutionPolicy(value: unknown): WorkflowNodeSnapshot['data']['executionPolicy'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const policy: NonNullable<WorkflowNodeSnapshot['data']['executionPolicy']> = {}
  if (Object.prototype.hasOwnProperty.call(record, 'allowedToolsets')) policy.allowedToolsets = stringArray(record.allowedToolsets)
  if (Object.prototype.hasOwnProperty.call(record, 'allowedTools')) policy.allowedTools = stringArray(record.allowedTools)
  if (record.skipMemory === true) policy.skipMemory = true
  if (record.skipContextFiles === true) policy.skipContextFiles = true
  return policy
}

function normalizeNode(raw: unknown): WorkflowNodeSnapshot | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : ''
  if (!id) return null
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : {}
  return {
    id,
    type: typeof record.type === 'string' && record.type ? record.type : 'agent',
    data: {
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : id,
      agent: typeof data.agent === 'string' && data.agent.trim() ? data.agent.trim() : 'hermes',
      provider: typeof data.provider === 'string' ? data.provider.trim() : '',
      model: typeof data.model === 'string' ? data.model.trim() : '',
      apiMode: typeof data.apiMode === 'string' ? data.apiMode.trim() : '',
      reasoningEffort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort.trim() : '',
      input: typeof data.input === 'string' ? data.input : '',
      skills: stringArray(data.skills),
      images: stringArray(data.images),
      approvalRequired: data.approvalRequired === true,
      executionPolicy: normalizeExecutionPolicy(data.executionPolicy),
    },
  }
}

const WORKFLOW_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function validateWorkflowNodeExecutionPolicies(nodes: unknown[]): void {
  for (const raw of nodes) {
    const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
    const rawData = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : {}
    if (Object.prototype.hasOwnProperty.call(rawData, 'executionPolicy')) {
      const policy = rawData.executionPolicy
      const validObject = policy && typeof policy === 'object' && !Array.isArray(policy)
      const allowedKeys = new Set(['allowedToolsets', 'allowedTools', 'skipMemory', 'skipContextFiles'])
      const valid = validObject
        && Object.keys(policy).every(key => allowedKeys.has(key))
        && ['allowedToolsets', 'allowedTools'].every(key => !Object.prototype.hasOwnProperty.call(policy, key)
          || (Array.isArray(policy[key]) && policy[key].every((item: unknown) => typeof item === 'string' && item.trim())))
        && ['skipMemory', 'skipContextFiles'].every(key => !Object.prototype.hasOwnProperty.call(policy, key)
          || typeof policy[key] === 'boolean')
      if (!valid) {
        const err = new Error('workflow node executionPolicy is invalid')
        ;(err as any).status = 400
        throw err
      }
    }
    const node = normalizeNode(raw)
    if (node?.data.executionPolicy && node.data.agent !== 'hermes') {
      const err = new Error('workflow node executionPolicy is supported for Hermes nodes only')
      ;(err as any).status = 400
      throw err
    }
  }
}

function validateWorkflowNodeTargets(nodes: unknown[]): void {
  for (const raw of nodes) {
    const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : {}
    const target = ['provider', 'model', 'apiMode'].map(key => typeof data[key] === 'string' ? data[key].trim() : '')
    const specified = target.filter(Boolean).length
    if (specified !== 0 && specified !== target.length) {
      const err = new Error('workflow node target must set provider, model, and apiMode together')
      ;(err as any).status = 400
      throw err
    }
    const reasoningEffort = typeof data.reasoningEffort === 'string' ? data.reasoningEffort.trim() : ''
    if (reasoningEffort && reasoningEffort !== 'default' && !WORKFLOW_REASONING_EFFORTS.has(reasoningEffort)) {
      const err = new Error('workflow node reasoningEffort is invalid')
      ;(err as any).status = 400
      throw err
    }
  }
}

export function workflowNodeRequiresApproval(node: { data?: { approvalRequired?: unknown } }): boolean {
  return node.data?.approvalRequired === true
}

function isUnfinishedWorkflowNodeStatus(status: WorkflowRuntimeState | undefined): boolean {
  return status === 'queued' || status === 'running' || status === 'pending_approval'
}

function normalizeEdge(raw: unknown): WorkflowEdgeSnapshot | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const source = typeof record.source === 'string' && record.source.trim() ? record.source.trim() : ''
  const target = typeof record.target === 'string' && record.target.trim() ? record.target.trim() : ''
  if (!source || !target) return null
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    source,
    target,
    data: record.data,
  }
}

function imageMediaType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

function lastAssistantOutput(sessionId: string, fallback?: string | null): string {
  const detail = getSessionDetail(sessionId)
  const messages = detail?.messages || []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant' && String(message.content || '').trim()) return String(message.content || '')
  }
  return String(fallback || '')
}

function isWorkflowCodingAgentSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null } | null): boolean {
  const agent = String(session?.agent || '').trim()
  return agent === 'claude' || agent === 'codex' || Boolean(session?.agent_session_id)
}

async function deleteHermesSessionIfPresent(sessionId: string, profile: string): Promise<void> {
  const targetProfile = profile || 'default'
  if (!listProfileNamesFromDisk().includes(targetProfile)) return
  try {
    const hermesSession = await getExactSessionDetailFromDbWithProfile(sessionId, targetProfile)
    if (!hermesSession) return
    const deleted = await deleteSessionForProfile(sessionId, targetProfile)
    if (!deleted) {
      logger.warn({ sessionId, profile: targetProfile }, '[workflow] failed to delete Hermes session for workflow run node')
    }
  } catch (err) {
    logger.warn({ err, sessionId, profile: targetProfile }, '[workflow] skipped Hermes session delete for workflow run node')
  }
}

function reachableFrom(startIds: string[], outgoing: Map<string, WorkflowEdgeSnapshot[]>): Set<string> {
  const visited = new Set<string>()
  const stack = [...startIds]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const edge of outgoing.get(id) || []) stack.push(edge.target)
  }
  return visited
}

export class WorkflowManager extends EventEmitter<WorkflowManagerEvents> {
  private readonly runtimeStatuses = new Map<string, WorkflowRuntimeStatus>()
  private readonly canceledRunIds = new Set<string>()
  private readonly pendingNodeApprovals = new Map<string, PendingNodeApproval>()

  list(profile?: string | null): WorkflowRecord[] {
    return listWorkflows(profile)
  }

  get(id: string): WorkflowRecord | null {
    return getWorkflow(id)
  }

  create(input: WorkflowCreateInput): WorkflowRecord {
    return createWorkflow(input)
  }

  validateRun(workflowId: string, input: WorkflowRunNowInput = {}): void {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    validateWorkflowNodeTargets(workflow.nodes)
    validateWorkflowNodeExecutionPolicies(workflow.nodes)
    let compiledGraph: ReturnType<typeof compileWorkflowGraph>
    try {
      compiledGraph = compileWorkflowGraph(workflow.nodes, workflow.edges)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      ;(err as any).status = 400
      throw err
    }
    const nodeIds = new Set(compiledGraph.nodes.map(node => node.id))
    if (nodeIds.size === 0) {
      const err = new Error('workflow has no nodes')
      ;(err as any).status = 400
      throw err
    }
    const inbound = new Set(compiledGraph.edges.filter(edge => !edge.policy.loop).map(edge => edge.target))
    const requestedInput = input.startNodeIds || []
    if (requestedInput.some(nodeId => !nodeIds.has(nodeId))) {
      const err = new Error('workflow start nodes are invalid')
      ;(err as any).status = 400
      throw err
    }
    const starts = requestedInput.length > 0 ? requestedInput : [...nodeIds].filter(nodeId => !inbound.has(nodeId))
    if (starts.length === 0) {
      const err = new Error('workflow has no start nodes')
      ;(err as any).status = 400
      throw err
    }
  }

  update(id: string, input: WorkflowUpdateInput): WorkflowRecord | null {
    return updateWorkflow(id, input)
  }

  async delete(id: string): Promise<boolean> {
    const workflow = getWorkflow(id)
    if (!workflow) return false
    const runs = listWorkflowRuns(id, 500)
    for (const run of runs) {
      await this.deleteRun(id, run.id)
    }
    const deleted = deleteWorkflow(id)
    if (deleted) this.runtimeStatuses.delete(id)
    return deleted
  }

  async stopRun(workflowId: string, runId: string, reason = 'Workflow run canceled'): Promise<WorkflowRunRecord | null> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return null
    this.canceledRunIds.add(runId)
    this.cancelPendingNodeApprovals(runId)
    const finishedAt = Date.now()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
    const nodeSessions = listWorkflowRunNodeSessions(runId)
    for (const session of nodeSessions) {
      const status = session.status === 'completed' || session.status === 'failed'
        ? session.status
        : 'canceled'
      nodeStatuses[session.node_id] = status
      if (status === 'canceled') {
        updateWorkflowRunNodeSession(session.id, {
          status: 'canceled',
          finished_at: finishedAt,
          error: reason,
        })
      }
      if (session.status === 'queued' || session.status === 'running') {
        await getChatRunServer()?.abortSession?.(session.session_id, reason)
      }
    }
    const stopped = updateWorkflowRun(runId, {
      status: 'canceled',
      finished_at: finishedAt,
      error: reason,
    }) || run
    this.setRuntimeStatus(workflowId, {
      status: 'canceled',
      runId,
      completedAt: finishedAt,
      error: reason,
      nodeStatuses,
    })
    return stopped
  }

  approveNode(workflowId: string, runId: string, nodeId: string, approved = true): boolean {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return false
    const pending = this.pendingNodeApprovals.get(this.nodeApprovalKey(runId, nodeId))
    if (!pending || pending.workflowId !== workflowId || pending.nodeId !== nodeId) return false
    this.pendingNodeApprovals.delete(this.nodeApprovalKey(runId, nodeId))
    pending.resolve(approved)
    return true
  }

  async deleteRun(workflowId: string, runId: string): Promise<boolean> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return false
    if (run.status === 'queued' || run.status === 'running') {
      await this.stopRun(workflowId, runId, 'Workflow run deleted')
    }
    const nodeSessions = listWorkflowRunNodeSessions(runId)
    for (const nodeSession of nodeSessions) {
      await this.deleteNodeSessionArtifacts(nodeSession.session_id, nodeSession.profile, nodeSession.agent)
    }
    this.canceledRunIds.delete(runId)
    return deleteWorkflowRun(runId)
  }

  private async deleteNodeSessionArtifacts(sessionId: string, profile: string, agent: string): Promise<void> {
    if (!sessionId) return
    const existing = getSession(sessionId)
    if (isWorkflowCodingAgentSession(existing)) {
      codingAgentRunManager.stop(sessionId, { reportClosed: false })
    } else if (agent === 'hermes') {
      await deleteHermesSessionIfPresent(sessionId, profile || existing?.profile || 'default')
    }
    if (existing) {
      deleteSession(sessionId)
    }
  }

  getRuntimeStatus(workflowId: string): WorkflowRuntimeStatus {
    return this.runtimeStatuses.get(workflowId) || idleStatus(workflowId)
  }

  listRuntimeStatuses(): WorkflowRuntimeStatus[] {
    return [...this.runtimeStatuses.values()]
  }

  setRuntimeStatus(
    workflowId: string,
    patch: Partial<Omit<WorkflowRuntimeStatus, 'workflowId' | 'updatedAt'>>,
  ): WorkflowRuntimeStatus {
    const previous = this.getRuntimeStatus(workflowId)
    const status: WorkflowRuntimeStatus = {
      ...previous,
      ...patch,
      nodeStatuses: patch.nodeStatuses || previous.nodeStatuses || {},
      workflowId,
      updatedAt: Date.now(),
    }
    this.runtimeStatuses.set(workflowId, status)
    this.emit('status', status)
    return status
  }

  onRuntimeStatus(listener: WorkflowStatusListener): () => void {
    this.on('status', listener)
    return () => this.off('status', listener)
  }

  private nodeApprovalKey(runId: string, nodeId: string): string {
    return `${runId}:${nodeId}`
  }

  private cancelPendingNodeApprovals(runId: string): void {
    for (const [key, pending] of this.pendingNodeApprovals) {
      if (pending.runId !== runId) continue
      this.pendingNodeApprovals.delete(key)
      pending.resolve(false)
    }
  }

  private async waitForNodeApproval(args: {
    workflowId: string
    runId: string
    node: WorkflowNodeSnapshot
    nodeStatuses: Record<string, WorkflowRuntimeState>
    deadlineAt?: number
  }): Promise<boolean> {
    if (!workflowNodeRequiresApproval(args.node)) return true
    if (this.canceledRunIds.has(args.runId) || getWorkflowRun(args.runId)?.status === 'canceled') return false

    args.nodeStatuses[args.node.id] = 'pending_approval'
    this.setRuntimeStatus(args.workflowId, {
      status: 'running',
      runId: args.runId,
      nodeStatuses: { ...args.nodeStatuses },
    })

    let resolveApproval: (approved: boolean) => void = () => {}
    const approval = new Promise<boolean>((resolve) => {
      resolveApproval = resolve
    })
    const key = this.nodeApprovalKey(args.runId, args.node.id)
    this.pendingNodeApprovals.set(key, {
      workflowId: args.workflowId,
      runId: args.runId,
      nodeId: args.node.id,
      resolve: resolveApproval,
    })

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const remainingMs = args.deadlineAt === undefined ? undefined : args.deadlineAt - Date.now()
      if (remainingMs !== undefined && remainingMs <= 0) throw new Error('workflow_timeout')
      const approved = remainingMs === undefined
        ? await approval
        : await Promise.race([
            approval,
            new Promise<never>((_resolve, reject) => {
              deadlineTimer = setTimeout(() => reject(new Error('workflow_timeout')), remainingMs)
            }),
          ])
      return approved && !this.canceledRunIds.has(args.runId) && getWorkflowRun(args.runId)?.status !== 'canceled'
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      this.pendingNodeApprovals.delete(key)
    }
  }

  async runNow(workflowId: string, input: WorkflowRunNowInput = {}): Promise<WorkflowRunNowResult> {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    const totalTimeoutMs = input.totalTimeoutMs ?? DEFAULT_WORKFLOW_TOTAL_TIMEOUT_MS
    const executionBudget = input.executionBudget ?? DEFAULT_WORKFLOW_EXECUTION_BUDGET
    if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs <= 0 || totalTimeoutMs > MAX_WORKFLOW_TOTAL_TIMEOUT_MS) {
      const err = new Error(`total_timeout_ms must be a positive integer no greater than ${MAX_WORKFLOW_TOTAL_TIMEOUT_MS}`)
      ;(err as any).status = 400
      throw err
    }
    if (!Number.isInteger(executionBudget) || executionBudget <= 0 || executionBudget > MAX_WORKFLOW_EXECUTION_BUDGET) {
      const err = new Error(`execution_budget must be a positive integer no greater than ${MAX_WORKFLOW_EXECUTION_BUDGET}`)
      ;(err as any).status = 400
      throw err
    }
    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available')
      ;(err as any).status = 503
      throw err
    }

    const profile = input.profile?.trim() || workflow.profile || 'default'
    validateWorkflowNodeTargets(workflow.nodes)
    validateWorkflowNodeExecutionPolicies(workflow.nodes)
    let compiledGraph: ReturnType<typeof compileWorkflowGraph>
    try {
      compiledGraph = compileWorkflowGraph(workflow.nodes, workflow.edges)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      ;(err as any).status = 400
      throw err
    }
    const joinModeByNodeId = new Map(compiledGraph.nodes.map(node => [node.id, node.joinMode]))
    const nodes = workflow.nodes.map(normalizeNode).filter(Boolean) as WorkflowNodeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const edges = workflow.edges.map(normalizeEdge).filter((edge): edge is WorkflowEdgeSnapshot =>
      Boolean(edge && nodeById.has(edge.source) && nodeById.has(edge.target)),
    )
    const compiledEdgeByRuntimeEdge = new Map(edges.map((edge, index) => [edge, compiledGraph.edges[index]]))
    const isFeedbackEdge = (edge: WorkflowEdgeSnapshot) => Boolean(compiledEdgeByRuntimeEdge.get(edge)?.policy.loop)
    const forwardEdges = edges.filter(edge => !isFeedbackEdge(edge))
    if (nodes.length === 0) {
      const err = new Error('workflow has no nodes')
      ;(err as any).status = 400
      throw err
    }

    const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of nodes) {
      incoming.set(node.id, [])
      outgoing.set(node.id, [])
    }
    for (const edge of forwardEdges) {
      incoming.get(edge.target)!.push(edge)
      outgoing.get(edge.source)!.push(edge)
    }
    const defaultStartIds = nodes.filter(node => (incoming.get(node.id) || []).length === 0).map(node => node.id)
    const requestedStartIds = input.startNodeIds || []
    if (requestedStartIds.some(id => !nodeById.has(id))) {
      const err = new Error('workflow start nodes are invalid')
      ;(err as any).status = 400
      throw err
    }
    const startNodeIds = requestedStartIds.length > 0 ? requestedStartIds : defaultStartIds
    if (startNodeIds.length === 0) {
      const err = new Error('workflow has no start nodes')
      ;(err as any).status = 400
      throw err
    }
    const activeIds = reachableFrom(startNodeIds, outgoing)
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const activeEdges = edges.filter(edge => activeIds.has(edge.source) && activeIds.has(edge.target))
    const activeForwardEdges = activeEdges.filter(edge => !isFeedbackEdge(edge))
    const activeIncoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const activeForwardIncoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const activeOutgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of activeNodes) {
      activeIncoming.set(node.id, [])
      activeForwardIncoming.set(node.id, [])
      activeOutgoing.set(node.id, [])
    }
    for (const edge of activeEdges) {
      activeIncoming.get(edge.target)!.push(edge)
      activeOutgoing.get(edge.source)!.push(edge)
    }
    for (const edge of activeForwardEdges) activeForwardIncoming.get(edge.target)!.push(edge)

    const startedAt = Date.now()
    const deadlineAt = startedAt + totalTimeoutMs
    const run = createWorkflowRun({
      workflow_id: workflow.id,
      profile,
      workspace: workflow.workspace,
      start_node_ids: startNodeIds,
      status: 'running',
      snapshot_nodes: workflow.nodes,
      snapshot_edges: workflow.edges,
      total_timeout_ms: totalTimeoutMs,
      execution_budget: executionBudget,
      started_at: startedAt,
    })
    this.canceledRunIds.delete(run.id)
    this.setRuntimeStatus(workflow.id, {
      status: 'running',
      runId: run.id,
      startedAt,
      completedAt: null,
      error: null,
      nodeStatuses: Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const])),
    })

    const completed = new Set<string>()
    const runningOrDone = new Set<string>()
    const edgeEvaluations = new Map<WorkflowEdgeSnapshot, WorkflowEdgeEvaluation>()
    const provisionallyHandledFailures: Array<{ node: WorkflowNodeSnapshot; error: string; targetIds: string[] }> = []
    const outputs = new Map<string, string>()
    const nodeSessionIds = new Map<string, string>()
    const nodeSessionRecordIds = new Map<string, string>()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const]))
    let sequence = 0
    let edgeEvaluationSequence = 0
    let reservedExecutions = 0
    const loopIterations = new Map<string, number>()
    const iterationPathForNode = (nodeId: string) => compiledGraph.edges
      .filter(edge => edge.policy.loop && edge.loopNodeIds?.includes(nodeId))
      .sort((left, right) => (left.loopOrder || 0) - (right.loopOrder || 0))
      .map(edge => loopIterations.get(edge.id) || 1)
    const pendingLoopRetries: Array<{ edgeId: string; nodeIds: string[] }> = []

    const recordEdgeEvaluation = (edge: WorkflowEdgeSnapshot, evaluation: WorkflowEdgeEvaluation) => {
      const compiledEdge = compiledEdgeByRuntimeEdge.get(edge)
      if (!compiledEdge) throw new Error(`compiled workflow edge is missing: ${edge.source} -> ${edge.target}`)
      edgeEvaluations.set(edge, evaluation)
      createWorkflowRunEdgeEvaluation({
        run_id: run.id,
        workflow_id: workflow.id,
        edge_id: compiledEdge.id,
        source_node_id: edge.source,
        target_node_id: edge.target,
        route: compiledEdge.policy.route,
        status: evaluation.status,
        reason: evaluation.reason,
        sequence: edgeEvaluationSequence++,
        iteration_path: iterationPathForNode(edge.source),
      })
      return evaluation
    }

    const failRun = (message: string) => {
      if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
        const finishedAt = Date.now()
        for (const node of activeNodes) {
          if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
        }
        const canceled = updateWorkflowRun(run.id, { status: 'canceled', finished_at: finishedAt, error: message }) || run
        this.setRuntimeStatus(workflow.id, {
          status: 'canceled',
          runId: run.id,
          completedAt: finishedAt,
          error: message,
          nodeStatuses: { ...nodeStatuses },
        })
        return canceled
      }
      const finishedAt = Date.now()
      const failed = updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: message }) || run
      this.setRuntimeStatus(workflow.id, {
        status: 'failed',
        runId: run.id,
        completedAt: finishedAt,
        error: message,
        nodeStatuses: { ...nodeStatuses },
      })
      return failed
    }

    try {
      while (completed.size < activeNodes.length) {
        if (Date.now() >= deadlineAt) throw new Error('workflow_timeout')
        const edgeIsTaken = (edge: WorkflowEdgeSnapshot) => edgeEvaluations.get(edge)?.status === 'taken'
        const nodeIsReady = (node: WorkflowNodeSnapshot) => {
          const inbound = activeForwardIncoming.get(node.id) || []
          if (inbound.length === 0) return true
          const joinMode = joinModeByNodeId.get(node.id) || 'all'
          if (joinMode === 'any') return inbound.some(edgeIsTaken)
          return inbound.every(edge => completed.has(edge.source)) && inbound.every(edgeIsTaken)
        }
        const pendingNodes = activeNodes.filter(node => !runningOrDone.has(node.id))
        let skippedNode = false
        for (const node of pendingNodes) {
          const inbound = activeForwardIncoming.get(node.id) || []
          if (inbound.length === 0 || !inbound.every(edge => completed.has(edge.source)) || nodeIsReady(node)) continue
          runningOrDone.add(node.id)
          completed.add(node.id)
          skippedNode = true
          nodeStatuses[node.id] = 'skipped'
          for (const edge of activeOutgoing.get(node.id) || []) {
            recordEdgeEvaluation(edge, { status: 'not_taken', reason: 'source node was skipped' })
          }
        }
        const ready = activeNodes.filter(node => !runningOrDone.has(node.id) && nodeIsReady(node))
        if (ready.length === 0) {
          if (completed.size === activeNodes.length) break
          if (skippedNode) continue
          throw new Error('workflow graph contains a cycle or blocked dependency')
        }
        const remainingBudget = executionBudget - reservedExecutions
        if (remainingBudget <= 0) throw new Error('execution_budget_exceeded')
        const dispatchReady = ready.slice(0, remainingBudget)
        reservedExecutions += dispatchReady.length
        for (const node of dispatchReady) nodeStatuses[node.id] = 'running'
        this.setRuntimeStatus(workflow.id, {
          status: 'running',
          runId: run.id,
          nodeStatuses: { ...nodeStatuses },
        })

        const results = await Promise.all(dispatchReady.map(async node => {
          const nodeSessionId = randomUUID()
          nodeSessionIds.set(node.id, nodeSessionId)
          runningOrDone.add(node.id)
          const target = resolveWorkflowNodeRunTarget(node.data.agent)
          const nodeSession = createWorkflowRunNodeSession({
            run_id: run.id,
            workflow_id: workflow.id,
            node_id: node.id,
            iteration_path: iterationPathForNode(node.id),
            session_id: nodeSessionId,
            profile,
            agent: target.agent,
            agent_mode: node.data.agent === 'hermes' ? '' : 'scoped',
            status: 'running',
            sequence: sequence++,
            started_at: Date.now(),
          })
          nodeSessionRecordIds.set(node.id, nodeSession.id)
          const assembledInput = await this.buildNodeUserMessage({
            node,
            incomingEdges: (activeIncoming.get(node.id) || []).filter(edge => edgeEvaluations.get(edge)?.status === 'taken'),
            nodeById,
            outputs,
            overrideInput: startNodeIds.includes(node.id) ? input.input : undefined,
            profile,
          })
          const remainingMs = deadlineAt - Date.now()
          if (remainingMs <= 0) throw new Error('workflow_timeout')
          let deadlineTimer: ReturnType<typeof setTimeout> | undefined
          const runResult = await Promise.race([
            chatRun.runAndWait({
              session_id: nodeSessionId,
              source: 'workflow',
              session_source: 'workflow',
              input: assembledInput,
              profile,
              workspace: workflow.workspace,
              model: node.data.model || undefined,
              provider: node.data.provider || undefined,
              mode: node.data.agent === 'hermes' ? undefined : 'scoped',
              coding_agent_id: target.codingAgentId,
              agent_id: target.codingAgentId,
              apiMode: node.data.apiMode || undefined,
              ...(node.data.reasoningEffort && node.data.reasoningEffort !== 'default'
                ? { reasoning_effort: node.data.reasoningEffort }
                : {}),
              ...(node.data.executionPolicy ? { execution_policy: node.data.executionPolicy } : {}),
            }, {
              profile,
              user: input.user,
              timeoutMs: input.timeoutMs,
              approvalChoice: 'once',
            }),
            new Promise<never>((_resolve, reject) => {
              deadlineTimer = setTimeout(() => {
                void chatRun.abortSession?.(nodeSessionId, 'workflow_timeout')
                reject(new Error('workflow_timeout'))
              }, remainingMs)
            }),
          ]).finally(() => {
            if (deadlineTimer) clearTimeout(deadlineTimer)
          })
          if (!runResult.ok) {
            const error = runResult.error || `node ${node.id} failed`
            if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
              updateWorkflowRunNodeSession(nodeSession.id, { status: 'canceled', finished_at: Date.now(), error })
              nodeStatuses[node.id] = 'canceled'
              this.setRuntimeStatus(workflow.id, {
                status: 'canceled',
                runId: run.id,
                error,
                nodeStatuses: { ...nodeStatuses },
              })
              return { node, ok: false, canceled: true, error }
            }
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'failed'
            outputs.set(node.id, `[Workflow node failed]\n${error}`)
            completed.add(node.id)
            const evaluations = (activeOutgoing.get(node.id) || []).map(edge =>
              recordEdgeEvaluation(edge, evaluateWorkflowEdge(edge, { nodeId: node.id, status: 'failure', error })),
            )
            const evaluationError = evaluations.find(evaluation => evaluation.status === 'error')
            if (evaluationError) throw new Error(evaluationError.reason)
            const handledTargetIds = (activeOutgoing.get(node.id) || [])
              .filter(edge => edgeEvaluations.get(edge)?.status === 'taken' && !runningOrDone.has(edge.target))
              .map(edge => edge.target)
            const handled = handledTargetIds.length > 0
            if (handled) provisionallyHandledFailures.push({ node, error, targetIds: handledTargetIds })
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: handled, handledFailure: handled, error }
          }
          const output = lastAssistantOutput(nodeSessionId, runResult.output)
          const approved = await this.waitForNodeApproval({
            workflowId: workflow.id,
            runId: run.id,
            node,
            nodeStatuses,
            deadlineAt,
          })
          if (!approved) {
            const error = 'Workflow node approval rejected'
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'approval_rejected', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'approval_rejected'
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              error,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, approvalRejected: true, error }
          }
          outputs.set(node.id, output)
          completed.add(node.id)
          for (const edge of activeOutgoing.get(node.id) || []) {
            const evaluation = recordEdgeEvaluation(edge, evaluateWorkflowEdge(edge, { nodeId: node.id, status: 'success', output }))
            if (evaluation.status === 'error') throw new Error(evaluation.reason)
            const compiledEdge = compiledEdgeByRuntimeEdge.get(edge)
            if (evaluation.status === 'taken' && compiledEdge?.policy.loop) {
              const iteration = loopIterations.get(compiledEdge.id) || 1
              if (iteration >= compiledEdge.policy.loop.maxIterations) {
                throw new Error(`loop_limit_exceeded: ${compiledEdge.id}`)
              }
              loopIterations.set(compiledEdge.id, iteration + 1)
              pendingLoopRetries.push({ edgeId: compiledEdge.id, nodeIds: compiledEdge.loopNodeIds || [] })
            }
          }
          nodeStatuses[node.id] = 'completed'
          this.setRuntimeStatus(workflow.id, {
            status: 'running',
            runId: run.id,
            nodeStatuses: { ...nodeStatuses },
          })
          updateWorkflowRunNodeSession(nodeSession.id, { status: 'completed', finished_at: Date.now(), error: null })
          return { node, ok: true }
        }))

        const failed = results.find(result => !result.ok)
        if (!failed && pendingLoopRetries.length > 0) {
          const retries = pendingLoopRetries.splice(0)
          const retryEdgeIds = new Set(retries.map(retry => retry.edgeId))
          const retrySourceIds = new Set(activeEdges
            .filter(edge => retryEdgeIds.has(compiledEdgeByRuntimeEdge.get(edge)?.id || ''))
            .map(edge => edge.source))
          for (const retry of retries) {
            const retryNodeIds = new Set(retry.nodeIds)
            for (const childLoop of compiledGraph.edges.filter(edge => edge.policy.loop && edge.id !== retry.edgeId)) {
              const childNodeIds = childLoop.loopNodeIds || []
              if (childNodeIds.length < retryNodeIds.size && childNodeIds.every(nodeId => retryNodeIds.has(nodeId))) {
                loopIterations.delete(childLoop.id)
              }
            }
            for (const nodeId of retry.nodeIds) {
              completed.delete(nodeId)
              runningOrDone.delete(nodeId)
              if (!retrySourceIds.has(nodeId)) outputs.delete(nodeId)
              nodeStatuses[nodeId] = 'queued'
              for (const edge of activeOutgoing.get(nodeId) || []) {
                if (!retryEdgeIds.has(compiledEdgeByRuntimeEdge.get(edge)?.id || '')) edgeEvaluations.delete(edge)
              }
            }
          }
        }
        if (failed) {
          for (const node of activeNodes) {
            if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
          }
          if ('canceled' in failed && failed.canceled) {
            const canceledRun = failRun(failed.error || 'Workflow run canceled')
            return { run: canceledRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          if ('approvalRejected' in failed && failed.approvalRejected) {
            const message = `Node ${failed.node.data.title || failed.node.id} approval rejected`
            const failedRun = failRun(message)
            return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          nodeStatuses[failed.node.id] = 'failed'
          const message = `Node ${failed.node.data.title || failed.node.id} failed: ${failed.error}`
          const failedRun = failRun(message)
          return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
        }
      }

      const unhandledFailure = provisionallyHandledFailures.find(failure =>
        failure.targetIds.every(targetId => nodeStatuses[targetId] === 'skipped'),
      )
      if (unhandledFailure) {
        const message = `Node ${unhandledFailure.node.data.title || unhandledFailure.node.id} failed: ${unhandledFailure.error}`
        const failedRun = failRun(message)
        return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
      }
      const finishedAt = Date.now()
      const completedRun = updateWorkflowRun(run.id, { status: 'completed', finished_at: finishedAt, error: null }) || run
      this.setRuntimeStatus(workflow.id, {
        status: 'completed',
        runId: run.id,
        completedAt: finishedAt,
        error: null,
        nodeStatuses: { ...nodeStatuses },
      })
      return { run: completedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
      for (const [nodeId, recordId] of nodeSessionRecordIds) {
        if (!completed.has(nodeId)) {
          nodeStatuses[nodeId] = canceled ? 'canceled' : 'failed'
          updateWorkflowRunNodeSession(recordId, { status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message })
        }
      }
      for (const node of activeNodes) {
        if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
      }
      const failedRun = failRun(message)
      return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    }
  }

  async rerunFromNode(
    workflowId: string,
    runId: string,
    nodeId: string,
    input: WorkflowRerunFromNodeInput = {},
  ): Promise<WorkflowRunNowResult> {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) {
      const err = new Error('workflow run not found')
      ;(err as any).status = 404
      throw err
    }
    if (run.status === 'queued' || run.status === 'running') {
      const err = new Error('workflow run is still active')
      ;(err as any).status = 409
      throw err
    }
    const hasOrchestratedSnapshot = run.snapshot_edges.some((edge: any) =>
      edge && typeof edge === 'object' && edge.data && typeof edge.data === 'object'
        && Object.prototype.hasOwnProperty.call(edge.data, 'orchestration'),
    ) || run.snapshot_nodes.some((node: any) => {
      const joinMode = node?.data?.joinMode
      return joinMode !== undefined && joinMode !== 'all'
    })
    if (hasOrchestratedSnapshot) {
      const err = new Error('partial rerun is not supported for orchestrated workflow snapshots')
      ;(err as any).status = 409
      throw err
    }

    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available')
      ;(err as any).status = 503
      throw err
    }

    const profile = input.profile?.trim() || run.profile || workflow.profile || 'default'
    const nodes = run.snapshot_nodes.map(normalizeNode).filter(Boolean) as WorkflowNodeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const targetNodeId = nodeId.trim()
    if (!targetNodeId || !nodeById.has(targetNodeId)) {
      const err = new Error('workflow node not found in run snapshot')
      ;(err as any).status = 404
      throw err
    }
    const edges = run.snapshot_edges.map(normalizeEdge).filter((edge): edge is WorkflowEdgeSnapshot =>
      Boolean(edge && nodeById.has(edge.source) && nodeById.has(edge.target)),
    )
    if (nodes.length === 0) {
      const err = new Error('workflow run snapshot has no nodes')
      ;(err as any).status = 400
      throw err
    }

    const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of nodes) {
      incoming.set(node.id, [])
      outgoing.set(node.id, [])
    }
    for (const edge of edges) {
      incoming.get(edge.target)!.push(edge)
      outgoing.get(edge.source)!.push(edge)
    }

    const existingNodeSessions = listWorkflowRunNodeSessions(run.id)
    const existingSessionByNode = new Map(existingNodeSessions.map(session => [session.node_id, session]))
    const preserveStartNode = Boolean(input.preserveStartNode)
    if (preserveStartNode) {
      const startSession = existingSessionByNode.get(targetNodeId)
      if (!startSession || startSession.status !== 'completed') {
        const err = new Error('workflow node has no completed output to preserve')
        ;(err as any).status = 409
        throw err
      }
    }
    const downstreamStartIds = (outgoing.get(targetNodeId) || []).map(edge => edge.target)
    const activeIds = preserveStartNode
      ? reachableFrom(downstreamStartIds, outgoing)
      : reachableFrom([targetNodeId], outgoing)
    let expandedActiveIds = true
    while (expandedActiveIds) {
      expandedActiveIds = false
      for (const activeNodeId of [...activeIds]) {
        for (const edge of incoming.get(activeNodeId) || []) {
          if (activeIds.has(edge.source)) continue
          const upstreamSession = existingSessionByNode.get(edge.source)
          if (upstreamSession?.status === 'completed') continue
          activeIds.add(edge.source)
          expandedActiveIds = true
        }
      }
    }
    if (activeIds.size === 0) {
      const err = new Error('workflow node has no downstream nodes to rerun')
      ;(err as any).status = 400
      throw err
    }
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const outputs = new Map<string, string>()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
    for (const session of existingNodeSessions) {
      if (activeIds.has(session.node_id)) continue
      nodeStatuses[session.node_id] = session.status === 'blocked' ? 'failed' : session.status
      if (session.status === 'completed') {
        outputs.set(session.node_id, lastAssistantOutput(session.session_id))
      }
    }

    for (const node of activeNodes) {
      for (const edge of incoming.get(node.id) || []) {
        if (activeIds.has(edge.source)) continue
        const upstreamSession = existingSessionByNode.get(edge.source)
        if (!upstreamSession || upstreamSession.status !== 'completed') {
          const upstream = nodeById.get(edge.source)
          const err = new Error(`Upstream node ${upstream?.data.title || edge.source} has no completed output`)
          ;(err as any).status = 409
          throw err
        }
      }
    }

    for (const session of existingNodeSessions.filter(item => activeIds.has(item.node_id))) {
      await this.deleteNodeSessionArtifacts(session.session_id, session.profile, session.agent)
    }
    deleteWorkflowRunNodeSessions(run.id, [...activeIds])

    const startedAt = Date.now()
    const updatedRun = updateWorkflowRun(run.id, {
      status: 'running',
      started_at: startedAt,
      finished_at: null,
      error: null,
    }) || run
    this.canceledRunIds.delete(run.id)
    for (const node of activeNodes) nodeStatuses[node.id] = 'queued'
    this.setRuntimeStatus(workflow.id, {
      status: 'running',
      runId: run.id,
      startedAt,
      completedAt: null,
      error: null,
      nodeStatuses: { ...nodeStatuses },
    })

    const completed = new Set<string>()
    const runningOrDone = new Set<string>()
    const nodeSessionRecordIds = new Map<string, string>()
    let sequence = existingNodeSessions
      .filter(session => !activeIds.has(session.node_id))
      .reduce((max, session) => Math.max(max, session.sequence), -1) + 1

    const failRun = (message: string) => {
      if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
        const finishedAt = Date.now()
        for (const node of activeNodes) {
          if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
        }
        const canceled = updateWorkflowRun(run.id, { status: 'canceled', finished_at: finishedAt, error: message }) || updatedRun
        this.setRuntimeStatus(workflow.id, {
          status: 'canceled',
          runId: run.id,
          completedAt: finishedAt,
          error: message,
          nodeStatuses: { ...nodeStatuses },
        })
        return canceled
      }
      const finishedAt = Date.now()
      const failed = updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: message }) || updatedRun
      this.setRuntimeStatus(workflow.id, {
        status: 'failed',
        runId: run.id,
        completedAt: finishedAt,
        error: message,
        nodeStatuses: { ...nodeStatuses },
      })
      return failed
    }

    try {
      while (completed.size < activeNodes.length) {
        const ready = activeNodes.filter(node => {
          if (runningOrDone.has(node.id)) return false
          return (incoming.get(node.id) || []).every(edge => (
            activeIds.has(edge.source) ? completed.has(edge.source) : outputs.has(edge.source)
          ))
        })
        if (ready.length === 0) {
          throw new Error('workflow graph contains a cycle or blocked dependency')
        }
        for (const node of ready) nodeStatuses[node.id] = 'running'
        this.setRuntimeStatus(workflow.id, {
          status: 'running',
          runId: run.id,
          nodeStatuses: { ...nodeStatuses },
        })

        const results = await Promise.all(ready.map(async node => {
          const nodeSessionId = randomUUID()
          runningOrDone.add(node.id)
          const target = resolveWorkflowNodeRunTarget(node.data.agent)
          const nodeSession = createWorkflowRunNodeSession({
            run_id: run.id,
            workflow_id: workflow.id,
            node_id: node.id,
            session_id: nodeSessionId,
            profile,
            agent: target.agent,
            agent_mode: node.data.agent === 'hermes' ? '' : 'scoped',
            status: 'running',
            sequence: sequence++,
            started_at: Date.now(),
          })
          nodeSessionRecordIds.set(node.id, nodeSession.id)
          const assembledInput = await this.buildNodeUserMessage({
            node,
            incomingEdges: incoming.get(node.id) || [],
            nodeById,
            outputs,
            profile,
          })
          const runResult = await chatRun.runAndWait({
            session_id: nodeSessionId,
            source: 'workflow',
            session_source: 'workflow',
            input: assembledInput,
            profile,
            workspace: run.workspace,
            model: node.data.model || undefined,
            provider: node.data.provider || undefined,
            mode: node.data.agent === 'hermes' ? undefined : 'scoped',
            coding_agent_id: target.codingAgentId,
            agent_id: target.codingAgentId,
            apiMode: node.data.apiMode || undefined,
          }, {
            profile,
            user: input.user,
            timeoutMs: input.timeoutMs,
            approvalChoice: 'once',
          })
          if (!runResult.ok) {
            const error = runResult.error || `node ${node.id} failed`
            if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
              updateWorkflowRunNodeSession(nodeSession.id, { status: 'canceled', finished_at: Date.now(), error })
              nodeStatuses[node.id] = 'canceled'
              this.setRuntimeStatus(workflow.id, {
                status: 'canceled',
                runId: run.id,
                error,
                nodeStatuses: { ...nodeStatuses },
              })
              return { node, ok: false, canceled: true, error }
            }
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'failed'
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, error }
          }
          const output = lastAssistantOutput(nodeSessionId, runResult.output)
          const approved = await this.waitForNodeApproval({
            workflowId: workflow.id,
            runId: run.id,
            node,
            nodeStatuses,
          })
          if (!approved) {
            const error = 'Workflow node approval rejected'
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'approval_rejected', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'approval_rejected'
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              error,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, approvalRejected: true, error }
          }
          outputs.set(node.id, output)
          completed.add(node.id)
          nodeStatuses[node.id] = 'completed'
          this.setRuntimeStatus(workflow.id, {
            status: 'running',
            runId: run.id,
            nodeStatuses: { ...nodeStatuses },
          })
          updateWorkflowRunNodeSession(nodeSession.id, { status: 'completed', finished_at: Date.now(), error: null })
          return { node, ok: true }
        }))

        const failed = results.find(result => !result.ok)
        if (failed) {
          for (const node of activeNodes) {
            if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
          }
          if ('canceled' in failed && failed.canceled) {
            const canceledRun = failRun(failed.error || 'Workflow run canceled')
            return { run: canceledRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          if ('approvalRejected' in failed && failed.approvalRejected) {
            const message = `Node ${failed.node.data.title || failed.node.id} approval rejected`
            const failedRun = failRun(message)
            return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          nodeStatuses[failed.node.id] = 'failed'
          const message = `Node ${failed.node.data.title || failed.node.id} failed: ${failed.error}`
          const failedRun = failRun(message)
          return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
        }
      }

      const finishedAt = Date.now()
      const completedRun = updateWorkflowRun(run.id, { status: 'completed', finished_at: finishedAt, error: null }) || updatedRun
      this.setRuntimeStatus(workflow.id, {
        status: 'completed',
        runId: run.id,
        completedAt: finishedAt,
        error: null,
        nodeStatuses: { ...nodeStatuses },
      })
      return { run: completedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
      for (const [rerunNodeId, recordId] of nodeSessionRecordIds) {
        if (!completed.has(rerunNodeId)) {
          nodeStatuses[rerunNodeId] = canceled ? 'canceled' : 'failed'
          updateWorkflowRunNodeSession(recordId, { status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message })
        }
      }
      for (const node of activeNodes) {
        if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
      }
      const failedRun = failRun(message)
      return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    }
  }

  private async buildNodeUserMessage(args: {
    node: WorkflowNodeSnapshot
    incomingEdges: WorkflowEdgeSnapshot[]
    nodeById: Map<string, WorkflowNodeSnapshot>
    outputs: Map<string, string>
    overrideInput?: string | null
    profile: string
  }): Promise<string | ContentBlock[]> {
    const parts: string[] = []
    if (args.incomingEdges.length > 0) {
      parts.push('[Workflow upstream results]')
      for (const edge of args.incomingEdges) {
        const upstream = args.nodeById.get(edge.source)
        parts.push(`\n[Upstream: ${upstream?.data.title || edge.source}]\n${args.outputs.get(edge.source) || ''}`)
      }
    }

    if (args.node.data.skills.length > 0) {
      parts.push('\n[Workflow selected skills]')
      for (const skillName of args.node.data.skills) {
        const skill = await resolveWorkflowSkillContent({
          agent: args.node.data.agent,
          profile: args.profile,
          skillName,
        })
        if (!skill) throw new Error(`Skill "${skillName}" not found for ${args.node.data.agent || 'hermes'}`)
        parts.push(`\n[Skill: ${skill.name}]\n${skill.content}`)
      }
    }

    const currentTask = args.overrideInput ?? args.node.data.input
    parts.push(`\n[Current task]\n${currentTask || 'Execute the current workflow node.'}`)
    const text = parts.join('\n').trim()
    if (args.node.data.images.length === 0) return text
    return [
      { type: 'text', text },
      ...args.node.data.images.map(path => ({
        type: 'image' as const,
        name: path.split(/[\\/]/).pop() || path,
        path,
        media_type: imageMediaType(path),
      })),
    ]
  }
}

let singleton: WorkflowManager | null = null

export function getWorkflowManager(): WorkflowManager {
  if (!singleton) {
    recoverInterruptedWorkflowRuns()
    singleton = new WorkflowManager()
  }
  return singleton
}
