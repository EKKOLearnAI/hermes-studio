/**
 * ChatRunSocket — Socket.IO namespace /chat-run.
 *
 * Thin orchestrator that delegates to specialized modules:
 * - handle-api-run.ts   → upstream /v1/responses streaming
 * - handle-bridge-run.ts → CLI bridge runs
 * - abort.ts             → run cancellation
 * - compression.ts       → context window management
 */

import type { Server, Socket } from 'socket.io'
import { logger } from '../../logger'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getSession } from '../../../db/hermes/session-store'
import { getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from '../hermes-profile'
import { AgentBridgeClient } from '../agent-bridge'
import { handleApiRun, resolveRunSource, loadSessionStateFromDb } from './handle-api-run'
import { handleBridgeRun, resumeBridgeRun } from './handle-bridge-run'
import { handleAbort } from './abort'
import { getOrCreateSession } from './compression'
import { handleSessionCommand, isSessionCommand, parseSessionCommand } from './session-command'
import { contentBlocksToString } from './content-blocks'
import type { ContentBlock, QueuedRun, SessionState } from './types'
import { authenticateUserToken, isAuthEnabled, type AuthenticatedUser } from '../../../middleware/user-auth'
import { userCanAccessProfile } from '../../../db/hermes/users-store'

export type { ContentBlock } from './types'

function currentProfileFromSocket(socket: Socket): string {
  const socketProfile = typeof socket.handshake.query?.profile === 'string'
    ? socket.handshake.query.profile.trim()
    : ''
  return socketProfile || getActiveProfileName() || 'default'
}

export class ChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private bridge = new AgentBridgeClient()
  /** sessionId → session state (messages, working status, events, run tracking) */
  private sessionMap = new Map<string, SessionState>()
  private bridgeResumePolls = new Set<string>()

  constructor(io: Server) {
    this.nsp = io.of('/chat-run')
  }

  init() {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[chat-run-socket] Socket.IO ready at /chat-run')
  }

  // --- Auth middleware ---

  private async authMiddleware(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token as string | undefined
    if (!await isAuthEnabled()) {
      next()
      return
    }

    const user = await authenticateUserToken(token || '')
    if (!user) {
      return next(new Error('Authentication failed'))
    }
    const socketProfile = String(socket.handshake.query?.profile || '').trim()
    if (socketProfile && !this.canAccessProfile(user, socketProfile)) {
      return next(new Error('Profile access denied'))
    }
    socket.data.user = user
    next()
  }

  // --- Connection handler ---

  private onConnection(socket: Socket) {
    const socketUser = socket.data.user as AuthenticatedUser | undefined
    const socketProfile = (socket.handshake.query?.profile as string) || 'default'
    const currentProfile = () => socketProfile || getActiveProfileName() || 'default'
    const profileExists = (profile: string) => {
      if (!profile || profile === 'default') return true
      return listProfileNamesFromDisk().includes(profile)
    }
    const resolveRunProfile = (sessionId?: string, requested?: string) => {
      const requestedProfile = typeof requested === 'string' ? requested.trim() : ''
      if (requestedProfile) {
        if (!profileExists(requestedProfile)) throw new Error(`Profile "${requestedProfile}" does not exist`)
        if (socketUser && !this.canAccessProfile(socketUser, requestedProfile)) {
          throw new Error(`Profile "${requestedProfile}" is not available for this user`)
        }
        return requestedProfile
      }
      if (!sessionId) {
        const profile = currentProfile()
        if (socketUser && !this.canAccessProfile(socketUser, profile)) {
          throw new Error(`Profile "${profile}" is not available for this user`)
        }
        return profile
      }
      const storedProfile = getSession(sessionId)?.profile || ''
      const profile = storedProfile && profileExists(storedProfile) ? storedProfile : currentProfile()
      if (socketUser && !this.canAccessProfile(socketUser, profile)) {
        throw new Error(`Profile "${profile}" is not available for this user`)
      }
      return profile
    }

    socket.on('run', async (data: {
      input: string | ContentBlock[]
      display_input?: string | ContentBlock[] | null
      display_role?: 'user' | 'command'
      storage_message?: string
      session_id?: string
      model?: string
      instructions?: string
      provider?: string
      model_groups?: Array<{ provider: string; models: string[] }>
      queue_id?: string
      source?: string
      profile?: string
    }) => {
      let runProfile: string
      try {
        runProfile = resolveRunProfile(data.session_id, data.profile)
      } catch (err) {
        socket.emit('run.failed', {
          event: 'run.failed',
          session_id: data.session_id,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      if (data.session_id) {
        const state = getOrCreateSession(this.sessionMap, data.session_id)
        const source = resolveRunSource(data.source, data.session_id)
        const command = parseSessionCommand(data.input)
        if (command && source === 'cli') {
          try {
            await handleSessionCommand(data.session_id, command, {
              nsp: this.nsp,
              socket,
              sessionMap: this.sessionMap,
              bridge: this.bridge,
              profile: runProfile,
              model: data.model,
              provider: data.provider,
              model_groups: data.model_groups,
              instructions: data.instructions,
              queueId: data.queue_id,
              runQueuedItem: this.runQueuedItem.bind(this),
            })
          } catch (err) {
            this.emitToSession(socket, data.session_id, 'session.command', {
              event: 'session.command',
              command: command.rawName,
              ok: false,
              action: 'error',
              message: err instanceof Error ? err.message : String(err),
            })
          }
          return
        }
        if (state.isWorking) {
          const queueId = data.queue_id || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
          state.queue.push({
            queue_id: queueId,
            input: data.input,
            model: data.model,
            provider: data.provider,
            model_groups: data.model_groups,
            instructions: data.instructions,
            profile: runProfile,
            source,
            originSocketId: socket.id,
          })
          this.nsp.to(`session:${data.session_id}`).emit('run.queued', {
            event: 'run.queued',
            session_id: data.session_id,
            queue_length: state.queue.length,
            queued_messages: this.serializeQueuedMessages(state.queue),
          })
          logger.info('[chat-run-socket] queued run for session %s (queue: %d)', data.session_id, state.queue.length)
          return
        }
        state.events = []
        state.isWorking = true
        state.profile = runProfile
        state.source = source
      }
      try {
        await this.handleRun(socket, data, runProfile)
      } catch (err) {
        if (data.session_id) {
          const state = this.sessionMap.get(data.session_id)
          if (state && !state.runId && !state.abortController && !state.activeRunMarker) {
            state.isWorking = false
            state.profile = undefined
          }
        }
        socket.emit('run.failed', {
          event: 'run.failed',
          session_id: data.session_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    socket.on('cancel_queued_run', (data: { session_id?: string; queue_id?: string }) => {
      if (!data.session_id || !data.queue_id) return
      const state = this.sessionMap.get(data.session_id)
      if (!state?.queue.length) return
      const before = state.queue.length
      state.queue = state.queue.filter(item => item.queue_id !== data.queue_id)
      if (state.queue.length === before) return
      this.nsp.to(`session:${data.session_id}`).emit('run.queued', {
        event: 'run.queued',
        session_id: data.session_id,
        queue_length: state.queue.length,
        queued_messages: this.serializeQueuedMessages(state.queue),
      })
      logger.info('[chat-run-socket] cancelled queued run %s for session %s (queue: %d)',
        data.queue_id, data.session_id, state.queue.length)
    })

    socket.on('resume', async (data: { session_id?: string }) => {
      if (!data.session_id) return
      const sid = data.session_id
      socket.join(`session:${sid}`)
      await this.resumeSession(socket, sid)
    })

    socket.on('abort', (data: { session_id?: string }) => {
      if (data.session_id) {
        void handleAbort(this.nsp, socket, data.session_id, this.sessionMap, this.bridge, this.runQueuedItem.bind(this))
      }
    })

    socket.on('approval.respond', async (data: { session_id?: string; approval_id?: string; choice?: string }) => {
      if (!data.session_id || !data.approval_id) return
      try {
        const result = await this.bridge.approvalRespond(data.approval_id, data.choice || 'deny')
        this.emitToSession(socket, data.session_id, 'approval.resolved', {
          event: 'approval.resolved',
          approval_id: data.approval_id,
          choice: data.choice || 'deny',
          resolved: Boolean(result.resolved),
        })
      } catch (err) {
        this.emitToSession(socket, data.session_id, 'approval.resolved', {
          event: 'approval.resolved',
          approval_id: data.approval_id,
          choice: data.choice || 'deny',
          resolved: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    socket.on('clarify.respond', async (data: { session_id?: string; clarify_id?: string; response?: string }) => {
      if (!data.session_id || !data.clarify_id) return
      this.clearClarifyEventState(data.session_id, data.clarify_id)
      try {
        const result = await this.bridge.clarifyRespond(data.clarify_id, data.response || '')
        this.emitToSession(socket, data.session_id, 'clarify.resolved', {
          event: 'clarify.resolved',
          clarify_id: data.clarify_id,
          resolved: Boolean((result as any)?.resolved),
        })
      } catch (err) {
        this.emitToSession(socket, data.session_id, 'clarify.resolved', {
          event: 'clarify.resolved',
          clarify_id: data.clarify_id,
          resolved: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  // --- Run dispatcher ---

  private async handleRun(
    socket: Socket,
    data: {
      input: string | ContentBlock[]
      display_input?: string | ContentBlock[] | null
      display_role?: 'user' | 'command'
      storage_message?: string
      session_id?: string
      model?: string
      provider?: string
      model_groups?: Array<{ provider: string; models: string[] }>
      instructions?: string
      source?: string
      queue_id?: string
      peerExcludeSocketId?: string
    },
    profile: string,
    skipUserMessage = false,
  ) {
    const source = resolveRunSource(data.source, data.session_id)
    if (data.session_id && source === 'cli' && isSessionCommand(data.input)) return

    if (source === 'cli') {
      let fullInstructions = data.instructions
        ? `${getSystemPrompt()}\n${data.instructions}`
        : getSystemPrompt()
      if (data.session_id) {
        const sessionRow = getSession(data.session_id)
        if (sessionRow?.workspace) {
          const workspaceCtx = `[Current working directory: ${sessionRow.workspace}]`
          fullInstructions = `\n${workspaceCtx}\n${fullInstructions}`
        }
      }

      await handleBridgeRun(
        this.nsp, socket, { ...data, instructions: fullInstructions }, profile,
        this.sessionMap, this.bridge,
        skipUserMessage,
        loadSessionStateFromDb,
        this.dequeueNextQueuedRun.bind(this),
      )
      return
    }

    await handleApiRun(
      this.nsp, socket, data, profile,
      this.sessionMap,
      skipUserMessage,
      this.dequeueNextQueuedRun.bind(this),
    )
  }

  // --- Resume ---

  private async resumeSession(socket: Socket, sid: string) {
    let state = this.sessionMap.get(sid)
    if (!state) {
      state = await loadSessionStateFromDb(sid, this.sessionMap)
      this.sessionMap.set(sid, state)
    }
    await this.reattachBridgeRun(socket, sid, state)
    socket.emit('resumed', {
      session_id: sid,
      messages: state.messages,
      messageTotal: state.messageTotal,
      messageLoadedCount: state.messageLoadedCount,
      messagePageLimit: state.messagePageLimit,
      hasMoreBefore: state.hasMoreBefore,
      isWorking: state.isWorking,
      isAborting: state.isAborting || false,
      events: state.isWorking ? state.events : [],
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      contextTokens: state.contextTokens,
      queueLength: state.queue?.length || 0,
      queueMessages: this.serializeQueuedMessages(state.queue || []),
    })

    logger.info('[chat-run-socket] socket %s resumed session %s (working: %s, messages: %d)',
      socket.id, sid, state.isWorking, state.messages.length)
  }

  private async reattachBridgeRun(socket: Socket, sid: string, state: SessionState) {
    if (state.runId && state.isWorking) return
    const session = getSession(sid)
    const profile = session?.profile || currentProfileFromSocket(socket)
    try {
      const status = await this.bridge.status(sid, profile) as Record<string, unknown>
      const running = status.running === true
      const runId = typeof status.current_run_id === 'string' ? status.current_run_id : ''
      if (!running || !runId) return
      state.isWorking = true
      state.isAborting = false
      state.runId = runId
      state.profile = profile
      state.source = 'cli'
      state.events = []
      const pollKey = `${sid}:${runId}`
      if (this.bridgeResumePolls.has(pollKey)) return
      this.bridgeResumePolls.add(pollKey)
      const instructions = this.resumeInstructionsForSession(sid)
      void resumeBridgeRun(
        this.nsp,
        socket,
        {
          sessionId: sid,
          runId,
          profile,
          instructions,
          model: session?.model,
          provider: session?.provider,
        },
        this.sessionMap,
        this.bridge,
        this.dequeueNextQueuedRun.bind(this),
      ).finally(() => {
        this.bridgeResumePolls.delete(pollKey)
      })
      logger.info('[chat-run-socket] reattached running bridge run %s for session %s', runId, sid)
    } catch (err) {
      logger.warn(err, '[chat-run-socket] bridge status lookup failed while resuming session %s', sid)
    }
  }

  private resumeInstructionsForSession(sessionId: string): string {
    let fullInstructions = getSystemPrompt()
    const sessionRow = getSession(sessionId)
    if (sessionRow?.workspace) {
      fullInstructions = `\n[Current working directory: ${sessionRow.workspace}]\n${fullInstructions}`
    }
    return fullInstructions
  }

  // --- Queue ---

  private dequeueNextQueuedRun(socket: Socket, sessionId: string, fallbackProfile = 'default') {
    const state = this.sessionMap.get(sessionId)
    if (!state?.queue.length) return false

    const next = state.queue.shift()!
    logger.info('[chat-run-socket] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
    this.nsp.to(`session:${sessionId}`).emit('run.queued', {
      event: 'run.queued',
      session_id: sessionId,
      queue_length: state.queue.length,
      dequeued_queue_id: next.queue_id,
      queued_messages: this.serializeQueuedMessages(state.queue),
    })
    this.runQueuedItem(socket, sessionId, next, fallbackProfile)
    return true
  }

  private runQueuedItem(socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile = 'default') {
    const skipUserMessage = next.displayInput === null
    void this.handleRun(socket, {
      input: next.input,
      display_input: next.displayInput,
      display_role: next.displayRole,
      storage_message: next.storageMessage,
      session_id: sessionId,
      model: next.model,
      provider: next.provider,
      model_groups: next.model_groups,
      instructions: next.instructions,
      source: next.source,
      queue_id: next.queue_id,
      peerExcludeSocketId: next.originSocketId,
    }, next.profile || fallbackProfile, skipUserMessage)
  }

  // --- Helpers ---

  private clearClarifyEventState(sessionId: string, clarifyId: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state?.events.length) return

    const nextEvents = state.events.filter(({ event, data }) => {
      if (event !== 'clarify.requested' && event !== 'clarify.resolved') return true
      return data?.clarify_id !== clarifyId
    })
    if (nextEvents.length !== state.events.length) {
      state.events = nextEvents
    }
  }

  private emitToSession(socket: Socket, sessionId: string, event: string, payload: any) {
    const tagged = { ...payload, session_id: sessionId }
    this.nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!this.nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  private serializeQueuedMessages(queue: QueuedRun[]) {
    return queue.filter(item => item.displayInput !== null).map(item => ({
      id: item.queue_id,
      role: item.displayRole || (typeof item.displayInput === 'string' && item.displayInput.trim().startsWith('/') ? 'command' : 'user'),
      content: contentBlocksToString(item.displayInput ?? item.input),
      timestamp: Math.floor(Date.now() / 1000),
      queued: true,
    }))
  }

  private canAccessProfile(user: AuthenticatedUser, profile: string): boolean {
    return user.role === 'super_admin' || userCanAccessProfile(user.id, profile)
  }

  /** Close all active upstream response streams */
  close() {
    for (const [sessionId, state] of this.sessionMap.entries()) {
      if (state.abortController) {
        try {
          state.abortController.abort()
        } catch (e) {
          logger.warn(e, '[chat-run-socket] failed to abort controller for session %s', sessionId)
        }
      }
    }
    this.sessionMap.clear()
    logger.info('[chat-run-socket] closed all connections and cleared state')
  }
}
