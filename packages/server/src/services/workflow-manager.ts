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
  createWorkflowRunNodeSession,
  deleteWorkflowRun,
  getWorkflowRun,
  listWorkflowRunNodeSessions,
  listWorkflowRuns,
  updateWorkflowRun,
  updateWorkflowRunNodeSession,
  type WorkflowRunNodeSessionRecord,
  type WorkflowRunRecord,
} from '../db/hermes/workflow-run-store'
import { deleteSession, getSession, getSessionDetail } from '../db/hermes/session-store'
import { deleteUsage } from '../db/hermes/usage-store'
import { getChatRunServer } from '../routes/hermes/chat-run'
import type { ContentBlock } from './hermes/run-chat'
import type { AuthenticatedUser } from '../middleware/user-auth'
import { resolveWorkflowSkillContent } from './workflow-skill-resolver'
import { codingAgentRunManager } from './agent-runner/coding-agent-run-manager'
import { deleteSessionForProfile } from './hermes/hermes-cli'
import { listProfileNamesFromDisk } from './hermes/hermes-profile'
import { logger } from './logger'

export type { WorkflowCreateInput, WorkflowRecord, WorkflowUpdateInput }

export type WorkflowRuntimeState = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
export type WorkflowRunType = 'workflow'
export type WorkflowNodeAgent = 'hermes' | 'claude-code' | 'codex'

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
    input: string
    skills: string[]
    images: string[]
  }
}

interface WorkflowEdgeSnapshot {
  id?: string
  source: string
  target: string
}

type WorkflowManagerEvents = {
  status: [WorkflowRuntimeStatus]
}

type WorkflowStatusListener = (status: WorkflowRuntimeStatus) => void

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
      input: typeof data.input === 'string' ? data.input : '',
      skills: stringArray(data.skills),
      images: stringArray(data.images),
    },
  }
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

  list(profile?: string | null): WorkflowRecord[] {
    return listWorkflows(profile)
  }

  get(id: string): WorkflowRecord | null {
    return getWorkflow(id)
  }

  create(input: WorkflowCreateInput): WorkflowRecord {
    return createWorkflow(input)
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
      deleteUsage(sessionId)
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

  async runNow(workflowId: string, input: WorkflowRunNowInput = {}): Promise<WorkflowRunNowResult> {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available')
      ;(err as any).status = 503
      throw err
    }

    const profile = input.profile?.trim() || workflow.profile || 'default'
    const nodes = workflow.nodes.map(normalizeNode).filter(Boolean) as WorkflowNodeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const edges = workflow.edges.map(normalizeEdge).filter((edge): edge is WorkflowEdgeSnapshot =>
      Boolean(edge && nodeById.has(edge.source) && nodeById.has(edge.target)),
    )
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
    for (const edge of edges) {
      incoming.get(edge.target)!.push(edge)
      outgoing.get(edge.source)!.push(edge)
    }
    const defaultStartIds = nodes.filter(node => (incoming.get(node.id) || []).length === 0).map(node => node.id)
    const requestedStartIds = (input.startNodeIds || []).filter(id => nodeById.has(id))
    const startNodeIds = requestedStartIds.length > 0 ? requestedStartIds : defaultStartIds
    if (startNodeIds.length === 0) {
      const err = new Error('workflow has no start nodes')
      ;(err as any).status = 400
      throw err
    }
    const activeIds = reachableFrom(startNodeIds, outgoing)
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const activeEdges = edges.filter(edge => activeIds.has(edge.source) && activeIds.has(edge.target))
    const activeIncoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const activeOutgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of activeNodes) {
      activeIncoming.set(node.id, [])
      activeOutgoing.set(node.id, [])
    }
    for (const edge of activeEdges) {
      activeIncoming.get(edge.target)!.push(edge)
      activeOutgoing.get(edge.source)!.push(edge)
    }

    const startedAt = Date.now()
    const run = createWorkflowRun({
      workflow_id: workflow.id,
      profile,
      workspace: workflow.workspace,
      start_node_ids: startNodeIds,
      status: 'running',
      snapshot_nodes: workflow.nodes,
      snapshot_edges: workflow.edges,
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
    const outputs = new Map<string, string>()
    const nodeSessionIds = new Map<string, string>()
    const nodeSessionRecordIds = new Map<string, string>()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const]))
    let sequence = 0

    const failRun = (message: string) => {
      if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
        const finishedAt = Date.now()
        for (const node of activeNodes) {
          if (nodeStatuses[node.id] === 'queued' || nodeStatuses[node.id] === 'running') nodeStatuses[node.id] = 'canceled'
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
        const ready = activeNodes.filter(node => {
          if (runningOrDone.has(node.id)) return false
          return (activeIncoming.get(node.id) || []).every(edge => completed.has(edge.source))
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
          nodeSessionIds.set(node.id, nodeSessionId)
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
            incomingEdges: activeIncoming.get(node.id) || [],
            nodeById,
            outputs,
            overrideInput: startNodeIds.includes(node.id) ? input.input : undefined,
            profile,
          })
          const runResult = await chatRun.runAndWait({
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
            if (nodeStatuses[node.id] === 'queued' || nodeStatuses[node.id] === 'running') nodeStatuses[node.id] = 'canceled'
          }
          if ('canceled' in failed && failed.canceled) {
            const canceledRun = failRun(failed.error || 'Workflow run canceled')
            return { run: canceledRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          nodeStatuses[failed.node.id] = 'failed'
          const message = `Node ${failed.node.data.title || failed.node.id} failed: ${failed.error}`
          const failedRun = failRun(message)
          return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
        }
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
        if (nodeStatuses[node.id] === 'queued' || nodeStatuses[node.id] === 'running') nodeStatuses[node.id] = 'canceled'
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
  if (!singleton) singleton = new WorkflowManager()
  return singleton
}
