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
import { getActiveProfileName } from '../hermes-profile'
import { AgentBridgeClient } from '../agent-bridge'
import { handleApiRun, resolveRunSource, loadSessionStateFromDb } from './handle-api-run'
import { handleBridgeRun } from './handle-bridge-run'
import { handleAbort } from './abort'
import { getOrCreateSession } from './compression'
import { handleSessionCommand, isSessionCommand, parseSessionCommand } from './session-command'
import type { ContentBlock, QueuedRun, SessionState } from './types'

export type { ContentBlock } from './types'

export class ChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private gatewayManager: any
  private bridge = new AgentBridgeClient()
  /** sessionId → session state (messages, working status, events, run tracking) */
  private sessionMap = new Map<string, SessionState>()

  constructor(io: Server, gatewayManager: any) {
    this.nsp = io.of('/chat-run')
    this.gatewayManager = gatewayManager
  }

  init() {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[chat-run-socket] Socket.IO ready at /chat-run')
  }

  // --- Auth middleware ---

  private async authMiddleware(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token as string | undefined
    if (!process.env.AUTH_DISABLED && process.env.AUTH_DISABLED !== '1') {
      const { getToken } = await import('../../auth')
      const serverToken = await getToken()
      if (serverToken && token !== serverToken) {
        return next(new Error('Authentication failed'))
      }
    }
    next()
  }

  // --- Connection handler ---

  private onConnection(socket: Socket) {
    const socketProfile = (socket.handshake.query?.profile as string) || 'default'
    const currentProfile = () => getActiveProfileName() || socketProfile || 'default'

    socket.on('run', async (data: {
      input: string | ContentBlock[]
      session_id?: string
      model?: string
      instructions?: string
      queue_id?: string
      source?: string
    }) => {
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
              gatewayManager: this.gatewayManager,
              profile: currentProfile(),
              model: data.model,
              instructions: data.instructions,
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
          state.queue.push({
            queue_id: data.queue_id || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            input: data.input,
            model: data.model,
            instructions: data.instructions,
            profile: currentProfile(),
            source,
          })
          this.nsp.to(`session:${data.session_id}`).emit('run.queued', {
            event: 'run.queued',
            session_id: data.session_id,
            queue_length: state.queue.length,
          })
          logger.info('[chat-run-socket] queued run for session %s (queue: %d)', data.session_id, state.queue.length)
          return
        }
        state.isWorking = true
        state.profile = currentProfile()
        state.source = source
      }
      try {
        await this.handleRun(socket, data, currentProfile())
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
      })
      logger.info('[chat-run-socket] cancelled queued run %s for session %s (queue: %d)',
        data.queue_id, data.session_id, state.queue.length)
    })

    socket.on('resume', async (data: { session_id?: string }) => {
      if (!data.session_id) return
      const sid = data.session_id
      socket.join(`session:${sid}`)
      this.resumeSession(socket, sid)
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
  }

  // --- Run dispatcher ---

  private async handleRun(
    socket: Socket,
    data: { input: string | ContentBlock[]; session_id?: string; model?: string; instructions?: string; source?: string },
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
        this.sessionMap, this.gatewayManager, this.bridge,
        skipUserMessage,
        loadSessionStateFromDb,
        this.dequeueNextQueuedRun.bind(this),
      )
      return
    }

    await handleApiRun(
      this.nsp, socket, data, profile,
      this.sessionMap, this.gatewayManager,
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
    socket.emit('resumed', {
      session_id: sid,
      messages: state.messages,
      isWorking: state.isWorking,
      isAborting: state.isAborting || false,
      events: state.isWorking ? state.events : [],
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      queueLength: state.queue?.length || 0,
    })

    logger.info('[chat-run-socket] socket %s resumed session %s (working: %s, messages: %d)',
      socket.id, sid, state.isWorking, state.messages.length)
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
    })
    this.runQueuedItem(socket, sessionId, next, fallbackProfile)
    return true
  }

  private runQueuedItem(socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile = 'default') {
    void this.handleRun(socket, {
      input: next.input,
      session_id: sessionId,
      model: next.model,
      instructions: next.instructions,
      source: next.source,
    }, next.profile || fallbackProfile, true)
  }

  // --- Helpers ---

  private emitToSession(socket: Socket, sessionId: string, event: string, payload: any) {
    const tagged = { ...payload, session_id: sessionId }
    this.nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!this.nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
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
