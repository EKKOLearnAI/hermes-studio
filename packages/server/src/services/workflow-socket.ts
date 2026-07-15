import type { Server, Socket } from 'socket.io'
import { authenticateUserToken, isAuthEnabled, type AuthenticatedUser } from '../middleware/user-auth'
import { listUserProfiles } from '../db/hermes/users-store'
import { getWorkflowRunWithEvidence, type WorkflowRunWithEvidenceRecord } from '../db/hermes/workflow-run-store'
import { logger } from './logger'
import {
  getWorkflowManager,
  type WorkflowManager,
  type WorkflowRecord,
  type WorkflowRuntimeStatus,
} from './workflow-manager'

const WORKFLOW_NAMESPACE = '/workflow'

interface WorkflowListRequest {
  profile?: string | null
}

export interface WorkflowSocketRuntimeStatus extends WorkflowRuntimeStatus {
  run: WorkflowRunWithEvidenceRecord | null
}

interface WorkflowStatusRequest {
  workflowId?: string | null
}

interface WorkflowSocketAck<T> {
  ok: boolean
  data?: T
  error?: string
}

type Ack<T> = (response: WorkflowSocketAck<T>) => void

function normalizeProfile(value: unknown): string | null {
  const profile = typeof value === 'string' ? value.trim() : ''
  return profile || null
}

function allowedProfileSet(user?: AuthenticatedUser): Set<string> | null {
  if (!user || user.role === 'super_admin') return null
  return new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
}

function canAccessProfile(user: AuthenticatedUser | undefined, profile: string | null): boolean {
  const allowed = allowedProfileSet(user)
  return !allowed || allowed.has(profile || 'default')
}

function filterAllowedWorkflows(user: AuthenticatedUser | undefined, workflows: WorkflowRecord[]): WorkflowRecord[] {
  const allowed = allowedProfileSet(user)
  if (!allowed) return workflows
  return workflows.filter(workflow => allowed.has(workflow.profile || 'default'))
}

function safeAck<T>(ack: Ack<T> | undefined, response: WorkflowSocketAck<T>): void {
  if (typeof ack === 'function') ack(response)
}

export class WorkflowSocketServer {
  private readonly nsp: ReturnType<Server['of']>
  private readonly manager: WorkflowManager
  private readonly removeStatusListener: () => void

  constructor(io: Server, manager: WorkflowManager = getWorkflowManager()) {
    this.manager = manager
    this.nsp = io.of(WORKFLOW_NAMESPACE)
    this.removeStatusListener = this.manager.onRuntimeStatus(status => this.emitRuntimeStatus(status))
  }

  init(): void {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[workflow-socket] Socket.IO ready at /workflow')
  }

  close(): void {
    this.removeStatusListener()
  }

  private async authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
    if (!await isAuthEnabled()) {
      next()
      return
    }

    const token = socket.handshake.auth?.token as string | undefined
    const user = await authenticateUserToken(token || '')
    if (!user) {
      next(new Error('Authentication failed'))
      return
    }

    const profile = normalizeProfile(socket.handshake.query?.profile)
    if (profile && !canAccessProfile(user, profile)) {
      next(new Error('Profile access denied'))
      return
    }

    socket.data.user = user
    next()
  }

  private onConnection(socket: Socket): void {
    socket.on('workflows.list', (request: WorkflowListRequest | Ack<{ workflows: WorkflowRecord[] }> | undefined, ack?: Ack<{ workflows: WorkflowRecord[] }>) => {
      const callback = typeof request === 'function' ? request : ack
      const payload = typeof request === 'function' ? {} : request || {}
      this.handleList(socket, payload, callback)
    })

    socket.on('workflow.status.subscribe', (request: WorkflowStatusRequest | Ack<{ statuses: WorkflowSocketRuntimeStatus[] }> | undefined, ack?: Ack<{ statuses: WorkflowSocketRuntimeStatus[] }>) => {
      const callback = typeof request === 'function' ? request : ack
      const payload = typeof request === 'function' ? {} : request || {}
      this.handleStatusSubscribe(socket, payload, callback)
    })

    socket.on('workflow.status.unsubscribe', (request: WorkflowStatusRequest | undefined, ack?: Ack<{ ok: true }>) => {
      this.handleStatusUnsubscribe(socket, request || {}, ack)
    })
  }

  private handleList(socket: Socket, request: WorkflowListRequest, ack?: Ack<{ workflows: WorkflowRecord[] }>): void {
    const user = socket.data.user as AuthenticatedUser | undefined
    const profile = normalizeProfile(request.profile)
    if (profile && !canAccessProfile(user, profile)) {
      safeAck(ack, { ok: false, error: `Profile "${profile}" is not available for this user` })
      return
    }

    const workflows = filterAllowedWorkflows(user, this.manager.list(profile))
    safeAck(ack, { ok: true, data: { workflows } })
  }

  private handleStatusSubscribe(socket: Socket, request: WorkflowStatusRequest, ack?: Ack<{ statuses: WorkflowSocketRuntimeStatus[] }>): void {
    const workflowId = typeof request.workflowId === 'string' ? request.workflowId.trim() : ''
    if (workflowId) {
      const workflow = this.manager.get(workflowId)
      const user = socket.data.user as AuthenticatedUser | undefined
      if (!workflow) {
        safeAck(ack, { ok: false, error: 'workflow not found' })
        return
      }
      if (!canAccessProfile(user, workflow.profile)) {
        safeAck(ack, { ok: false, error: `Profile "${workflow.profile}" is not available for this user` })
        return
      }

      try {
        const status = this.statusWithEvidence(this.manager.getRuntimeStatus(workflowId))
        void socket.join(this.workflowRoom(workflowId))
        safeAck(ack, { ok: true, data: { statuses: [status] } })
      } catch (err: any) {
        logger.error(err, '[workflow-socket] failed to load persisted execution evidence for workflow %s', workflowId)
        safeAck(ack, { ok: false, error: err?.message || 'workflow evidence read failed' })
      }
      return
    }

    const user = socket.data.user as AuthenticatedUser | undefined
    const workflows = filterAllowedWorkflows(user, this.manager.list())
    const workflowIds = new Set(workflows.map(workflow => workflow.id))
    for (const id of workflowIds) void socket.join(this.workflowRoom(id))
    try {
      const statuses = this.manager.listRuntimeStatuses()
        .filter(status => workflowIds.has(status.workflowId))
        .map(status => this.statusWithEvidence(status))
      safeAck(ack, { ok: true, data: { statuses } })
    } catch (err: any) {
      logger.error(err, '[workflow-socket] failed to load persisted execution evidence for workflow status subscription')
      safeAck(ack, { ok: false, error: err?.message || 'workflow evidence read failed' })
    }
  }

  private handleStatusUnsubscribe(socket: Socket, request: WorkflowStatusRequest, ack?: Ack<{ ok: true }>): void {
    const workflowId = typeof request.workflowId === 'string' ? request.workflowId.trim() : ''
    if (workflowId) void socket.leave(this.workflowRoom(workflowId))
    else {
      for (const room of socket.rooms) {
        if (room.startsWith('workflow:') && room.endsWith(':status')) void socket.leave(room)
      }
    }
    safeAck(ack, { ok: true, data: { ok: true } })
  }

  private statusWithEvidence(status: WorkflowRuntimeStatus): WorkflowSocketRuntimeStatus {
    if (!status.runId) return { ...status, run: null }
    const run = getWorkflowRunWithEvidence(status.runId)
    if (!run) throw new Error(`workflow run ${status.runId} is unavailable while loading persisted evidence`)
    return { ...status, run }
  }

  private emitRuntimeStatus(status: WorkflowRuntimeStatus): void {
    try {
      this.nsp.to(this.workflowRoom(status.workflowId)).emit('workflow.status.updated', this.statusWithEvidence(status))
    } catch (err: any) {
      logger.error(err, '[workflow-socket] failed to load persisted execution evidence for workflow %s', status.workflowId)
      this.nsp.to(this.workflowRoom(status.workflowId)).emit('workflow.status.error', {
        workflowId: status.workflowId,
        runId: status.runId,
        error: err?.message || 'workflow evidence read failed',
      })
    }
  }

  private workflowRoom(workflowId: string): string {
    return `workflow:${workflowId}:status`
  }
}
