/**
 * ChatRunSocket — Socket.IO namespace /chat-run.
 *
 * Thin orchestrator that delegates to specialized modules:
 * - handle-bridge-run.ts → CLI bridge runs
 * - abort.ts             → run cancellation
 * - compression.ts       → context window management
 */

import type { Server, Socket } from 'socket.io'
import { logger } from '../../logger'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { clearSessionMessages, getSession, getSessionDetail  } from '../../../db/hermes/session-store'
import { getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from '../hermes-profile'
import { AgentBridgeClient } from '../agent-bridge'
import { getAgentBridgeManager } from '../agent-bridge/manager'
import { redactAgentBridgeError } from '../agent-bridge/redact'
import { handleBridgeRun, resumeBridgeRun } from './handle-bridge-run'
import { handleCodingAgentRun } from './handle-coding-agent-run'
import { handleAbort } from './abort'
import { getOrCreateSession } from './compression'
import { loadSessionStateFromDb, resolveRunSource } from './load-state'
import { handleSessionCommand, isSessionCommand, parseSessionCommand } from './session-command'
import { contentBlocksToString } from './content-blocks'
import type { ContentBlock, QueuedRun, SessionState } from './types'
import { authenticateUserToken, isAuthEnabled, type AuthenticatedUser } from '../../../middleware/user-auth'
import { userCanAccessProfile } from '../../../db/hermes/users-store'
import { observeRunChatPetEvent } from '../pet-state-socket'

export type { ContentBlock } from './types'

function currentProfileFromSocket(socket: Socket): string {
  const socketProfile = typeof socket.handshake.query?.profile === 'string'
    ? socket.handshake.query.profile.trim()
    : ''
  return socketProfile || getActiveProfileName() || 'default'
}

function redactBridgeReadyError(error: string, endpoint?: string): string {
  const normalized = error.replace(/^Error:\s*/, '').trim() || 'unknown error'
  return redactAgentBridgeError(normalized, endpoint, 'configured endpoint') || 'unknown error'
}

function isBridgeStatusLookupTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /^Agent bridge request timed out after \d+ms$/.test(message.trim())
}

function isHermesWorkerBackedSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null }): boolean {
  const source = session?.source || undefined
  // "api_server" is a legacy/default source value; Hermes sessions still use worker-backed runtime.
  // coding_agent runs have a separate lifecycle.
  if (!source || source === 'cli' || source === 'api_server') return true
  if (source === 'workflow') {
    const agent = String(session?.agent || '').trim()
    return agent !== 'claude' && agent !== 'codex' && !session?.agent_session_id
  }
  if (source !== 'global_agent') return false
  const agent = String(session?.agent || '').trim()
  return agent !== 'claude' && agent !== 'codex' && !session?.agent_session_id
}

function isBridgeRunSource(source?: string): boolean {
  return source === 'cli' || source === 'global_agent' || source === 'workflow'
}

export async function ensureBridgeReadyForChatRun(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const readiness = await getAgentBridgeManager().ensureReady({ timeoutMs: 1000, connectRetryMs: 0, recover: false })
    if (readiness.reachable) {
      return { ok: true }
    }
    return {
      ok: false,
      error: redactBridgeReadyError(readiness.error || `Agent Bridge is ${readiness.status}`, readiness.endpoint),
    }
  } catch (err) {
    return {
      ok: false,
      error: redactBridgeReadyError(err instanceof Error ? err.message : String(err)),
    }
  }
}

function isCodingAgentExecution(source: string | undefined, data?: { coding_agent_id?: string; agent_id?: string }): boolean {
  return source === 'coding_agent' || (source === 'workflow' && Boolean(data?.coding_agent_id || data?.agent_id))
}

export interface ChatRunAndWaitResult {
  ok: boolean
  event: 'run.completed' | 'run.failed'
  session_id: string
  run_id?: string
  output?: string | null
  reasoning?: string | null
  error?: string
}

type ChatRunAutoApprovalChoice = 'once' | 'session' | 'always'

export class ChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private bridge = new AgentBridgeClient()
  /** sessionId → session state (messages, working status, events, run tracking) */
  private sessionMap = new Map<string, SessionState>()
  private bridgeResumePolls = new Set<string>()
  private readonly runWaiters = new Map<string, Set<(event: string, payload: any) => void>>()

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
      workspace?: string | null
      source?: string
      session_source?: 'global_agent' | 'workflow'
      coding_agent_id?: 'claude-code' | 'codex'
      agent_id?: 'claude-code' | 'codex'
      mode?: 'scoped' | 'global'
      baseUrl?: string
      base_url?: string
      apiKey?: string
      api_key?: string
      apiMode?: string
      api_mode?: string
      profile?: string
      allow_command_passthrough?: boolean
      // Local patch (reasoning-effort): per-session reasoning effort override.
      reasoning_effort?: string
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
        if (command && (isBridgeRunSource(source) || command.name === 'branch')) {
          try {
            const handled = await handleSessionCommand(data.session_id, command, {
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
            if (handled !== false) return
            data.allow_command_passthrough = true
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
            workspace: data.workspace,
            source,
            sessionSource: data.session_source,
            codingAgentId: data.coding_agent_id,
            agentId: data.agent_id,
            mode: data.mode,
            baseUrl: data.baseUrl,
            base_url: data.base_url,
            apiKey: data.apiKey,
            api_key: data.api_key,
            apiMode: data.apiMode,
            api_mode: data.api_mode,
            commandPassthrough: data.allow_command_passthrough,
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
        state.isWorking = !isCodingAgentExecution(source, data)
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
      workspace?: string | null
      source?: string
      session_source?: 'global_agent' | 'workflow'
      queue_id?: string
      peerExcludeSocketId?: string
      coding_agent_id?: 'claude-code' | 'codex'
      agent_id?: 'claude-code' | 'codex'
      mode?: 'scoped' | 'global'
      baseUrl?: string
      base_url?: string
      apiKey?: string
      api_key?: string
      apiMode?: string
      api_mode?: string
      one_shot_model?: boolean
      allow_command_passthrough?: boolean
      onEvent?: (event: string, payload: any) => void
    },
    profile: string,
    skipUserMessage = false,
  ) {
    const source = resolveRunSource(data.source, data.session_id)
    if (data.session_id && isBridgeRunSource(source) && isSessionCommand(data.input) && data.allow_command_passthrough !== true) return

    if (!isCodingAgentExecution(source, data)) {
      const bridgeReady = await ensureBridgeReadyForChatRun()
      if (!bridgeReady.ok) {
        let shouldDequeueNext = false
        let queueRemaining = 0
        if (data.session_id) {
          const state = this.sessionMap.get(data.session_id)
          queueRemaining = state?.queue?.length ?? 0
          const canReleaseCurrentRun = state && !state.runId && !state.abortController && !state.activeRunMarker
          if (canReleaseCurrentRun) {
            if (queueRemaining > 0) {
              const nextQueuedRun = state.queue[0]
              state.isWorking = true
              state.profile = nextQueuedRun?.profile || profile
              state.source = nextQueuedRun?.source
              shouldDequeueNext = true
            } else {
              state.isWorking = false
              state.profile = undefined
            }
          }
        }
        const payload: {
          event: 'run.failed'
          session_id?: string
          error: string
          queue_remaining?: number
        } = {
          event: 'run.failed',
          session_id: data.session_id,
          error: `Agent Bridge is not reachable: ${bridgeReady.error}`,
        }
        if (queueRemaining > 0) payload.queue_remaining = queueRemaining
        socket.emit('run.failed', payload)
        if (data.session_id && shouldDequeueNext) {
          this.dequeueNextQueuedRun(socket, data.session_id, profile)
        }
        return
      }

      let fullInstructions = data.instructions
        ? `${getSystemPrompt(undefined, { source })}\n${data.instructions}`
        : getSystemPrompt(undefined, { source })

      await handleBridgeRun(
        this.nsp, socket, { ...data, instructions: fullInstructions }, profile,
        this.sessionMap, this.bridge,
        skipUserMessage,
        loadSessionStateFromDb,
        this.dequeueNextQueuedRun.bind(this),
      )
      return
    }

    await handleCodingAgentRun(
      this.nsp,
      socket,
      data,
      profile,
      this.sessionMap,
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
    const resumeEvents = state.isWorking
      ? state.events
      : (state.events || []).filter(evt => evt?.event === 'run.reattach_failed')
    const sessionDetail = getSessionDetail(sid)
    socket.emit('resumed', {
      session_id: sid,
      messages: state.messages,
      messageTotal: state.messageTotal,
      messageLoadedCount: state.messageLoadedCount,
      messagePageLimit: state.messagePageLimit,
      hasMoreBefore: state.hasMoreBefore,
      parentSessionId: sessionDetail?.parent_session_id || null,
      forkPointMessageId: sessionDetail?.fork_point_message_id || null,
      parentTitle: sessionDetail?.parent_title || null,
      parentLastMessage: sessionDetail?.parent_last_message || null,
      parentLastMessageRole: sessionDetail?.parent_last_message_role || null,
      isWorking: state.isWorking,
      isAborting: state.isAborting || false,
      events: resumeEvents,
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
    const source = state.source || session?.source
    if (!isHermesWorkerBackedSession({ source, agent: session?.agent, agent_session_id: session?.agent_session_id })) return
    const profile = session?.profile || currentProfileFromSocket(socket)
    let pollKey: string | undefined
    try {
      const status = await this.bridge.statusIfLoaded(sid, profile, { timeoutMs: 1000 }) as Record<string, unknown>
      const running = status.running === true
      const runId = typeof status.current_run_id === 'string' ? status.current_run_id : ''
      if (!running || !runId) return
      pollKey = `${sid}:${runId}`
      if (this.bridgeResumePolls.has(pollKey)) return
      this.bridgeResumePolls.add(pollKey)
      state.isWorking = true
      state.isAborting = state.isAborting === true
      state.runId = runId
      state.activeRunMarker = undefined
      state.profile = profile
      state.source = source === 'global_agent' ? 'global_agent' : 'cli'
      state.events = []
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
          workspace: session?.workspace,
          source,
        },
        this.sessionMap,
        this.bridge,
        this.dequeueNextQueuedRun.bind(this),
      ).finally(() => {
        if (pollKey) this.bridgeResumePolls.delete(pollKey!)
      })
      logger.info('[chat-run-socket] reattached running bridge run %s for session %s', runId, sid)
    } catch (err) {
      if (pollKey) this.bridgeResumePolls.delete(pollKey)
      if (isBridgeStatusLookupTimeout(err)) {
        logger.debug(err, '[chat-run-socket] bridge status lookup timed out while resuming session %s', sid)
        return
      }
      logger.warn(err, '[chat-run-socket] bridge status lookup failed while resuming session %s', sid)
      const endpoint = getAgentBridgeManager().getRuntimeState?.().endpoint
      const error = redactBridgeReadyError(err instanceof Error ? err.message : String(err), endpoint)
      const payload = {
        event: 'run.reattach_failed',
        session_id: sid,
        error,
        message: `Unable to confirm Agent Bridge status while resuming: ${error}`,
        text: `Unable to confirm Agent Bridge status while resuming: ${error}`,
      }
      const nextEvents = [...(state.events || [])]
      const lastEvent = nextEvents[nextEvents.length - 1]
      if (lastEvent?.event !== 'run.reattach_failed' || lastEvent?.data?.error !== error) {
        nextEvents.push({ event: 'run.reattach_failed', data: payload })
        state.events = nextEvents
      }
      this.emitToSession(socket, sid, 'run.reattach_failed', payload)
    }
  }

  private resumeInstructionsForSession(sessionId: string): string {
    const sessionRow = getSession(sessionId)
    return getSystemPrompt(undefined, { source: sessionRow?.source })
  }

  // --- Queue ---

  private dequeueNextQueuedRun(socket: Socket, sessionId: string, fallbackProfile = 'default') {
    const state = this.sessionMap.get(sessionId)
    if (!state?.queue.length) return false

    const next = state.queue.shift()!
    state.isWorking = true
    state.profile = next.profile || fallbackProfile
    state.source = next.source
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
      workspace: next.workspace,
      source: next.source,
      session_source: next.sessionSource,
      queue_id: next.queue_id,
      peerExcludeSocketId: next.originSocketId,
      coding_agent_id: next.codingAgentId,
      agent_id: next.agentId,
      mode: next.mode,
      baseUrl: next.baseUrl,
      base_url: next.base_url,
      apiKey: next.apiKey,
      api_key: next.api_key,
      apiMode: next.apiMode,
      api_mode: next.api_mode,
      one_shot_model: next.oneShotModel,
      allow_command_passthrough: next.commandPassthrough,
    }, next.profile || fallbackProfile, skipUserMessage)
  }

  // --- Helpers ---

  async runAndWait(
    data: {
      input: string | ContentBlock[]
      display_input?: string | ContentBlock[] | null
      display_role?: 'user' | 'command'
      storage_message?: string
      session_id: string
      model?: string
      provider?: string
      model_groups?: Array<{ provider: string; models: string[] }>
      instructions?: string
      workspace?: string | null
      source?: string
      session_source?: 'global_agent' | 'workflow'
      queue_id?: string
      coding_agent_id?: 'claude-code' | 'codex'
      agent_id?: 'claude-code' | 'codex'
      mode?: 'scoped' | 'global'
      baseUrl?: string
      base_url?: string
      apiKey?: string
      api_key?: string
      apiMode?: string
      api_mode?: string
      profile?: string
      reasoning_effort?: string
    },
    options: { profile?: string; user?: AuthenticatedUser; timeoutMs?: number; approvalChoice?: ChatRunAutoApprovalChoice } = {},
  ): Promise<ChatRunAndWaitResult> {
    const sessionId = String(data.session_id || '').trim()
    if (!sessionId) throw new Error('session_id is required')
    const profile = options.profile || data.profile || getSession(sessionId)?.profile || getActiveProfileName() || 'default'
    const source = resolveRunSource(data.source, sessionId)
    const state = getOrCreateSession(this.sessionMap, sessionId)
    state.events = []
    state.isWorking = !isCodingAgentExecution(source, data)
    state.profile = profile
    state.source = source

    return new Promise<ChatRunAndWaitResult>((resolve) => {
      let settled = false
      let output = ''
      let reasoning = ''
      let runId = ''
      const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : null
      const waiters = this.runWaiters.get(sessionId) || new Set<(event: string, payload: any) => void>()
      const finish = (result: Omit<ChatRunAndWaitResult, 'session_id'>) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        waiters.delete(onEvent)
        if (waiters.size === 0) this.runWaiters.delete(sessionId)
        resolve({
          session_id: sessionId,
          run_id: runId || result.run_id,
          output: output || result.output,
          reasoning: reasoning || result.reasoning,
          ...result,
        })
      }
      const respondToApproval = async (payload: any = {}) => {
        const choice = options.approvalChoice
        if (!choice || settled) return
        const approvalId = typeof payload.approval_id === 'string' ? payload.approval_id : ''
        const rawChoices = Array.isArray(payload.choices) ? payload.choices.map((item: unknown) => String(item)) : []
        const choices = rawChoices.length > 0 ? rawChoices : ['once', 'session', 'deny']
        if (!approvalId) {
          finish({ ok: false, event: 'run.failed', output, reasoning, error: 'approval required' })
          return
        }
        if (!choices.includes(choice)) {
          finish({ ok: false, event: 'run.failed', output, reasoning, error: `approval choice "${choice}" is not available` })
          return
        }
        try {
          const result = await this.bridge.approvalRespond(approvalId, choice)
          const resolvedPayload = {
            event: 'approval.resolved',
            session_id: sessionId,
            approval_id: approvalId,
            choice,
            resolved: Boolean((result as any)?.resolved),
          }
          this.nsp.to(`session:${sessionId}`).emit('approval.resolved', resolvedPayload)
          onEvent('approval.resolved', resolvedPayload)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          this.nsp.to(`session:${sessionId}`).emit('approval.resolved', {
            event: 'approval.resolved',
            session_id: sessionId,
            approval_id: approvalId,
            choice,
            resolved: false,
            error,
          })
          finish({ ok: false, event: 'run.failed', output, reasoning, error })
        }
      }
      const onEvent = (event: string, payload: any = {}) => {
        if (typeof payload.run_id === 'string' && payload.run_id) runId = payload.run_id
        if (event === 'message.delta' && typeof payload.delta === 'string') output += payload.delta
        if ((event === 'reasoning.delta' || event === 'thinking.delta') && typeof payload.delta === 'string') reasoning += payload.delta
        if (event === 'approval.requested') {
          void respondToApproval(payload)
        } else if (event === 'run.completed') {
          finish({
            ok: true,
            event: 'run.completed',
            run_id: payload.run_id,
            output: typeof payload.output === 'string' && payload.output ? payload.output : output,
            reasoning: typeof payload.reasoning === 'string' && payload.reasoning ? payload.reasoning : reasoning,
          })
        } else if (event === 'run.failed') {
          finish({
            ok: false,
            event: 'run.failed',
            run_id: payload.run_id,
            output,
            reasoning,
            error: payload.error ? String(payload.error) : 'chat-run failed',
          })
        }
      }
      const timer = timeoutMs
        ? setTimeout(() => {
            finish({ ok: false, event: 'run.failed', error: `chat-run timed out after ${timeoutMs}ms` })
          }, timeoutMs)
        : null
      waiters.add(onEvent)
      this.runWaiters.set(sessionId, waiters)

      const fakeSocket = {
        id: `workflow-run-${sessionId}`,
        connected: true,
        data: { user: options.user },
        join: () => {},
        to: (room: string) => ({
          emit: (event: string, payload: any) => {
            this.nsp.to(room).emit(event, payload)
            onEvent(event, payload)
          },
        }),
        emit: (event: string, payload: any) => onEvent(event, payload),
      } as unknown as Socket

      this.handleRun(fakeSocket, { ...data, onEvent }, profile)
        .catch(err => finish({ ok: false, event: 'run.failed', error: err instanceof Error ? err.message : String(err) }))
    })
  }

  async abortSession(sessionId: string, reason = 'Run canceled'): Promise<void> {
    const sid = String(sessionId || '').trim()
    if (!sid) return
    const fakeSocket = {
      id: `workflow-abort-${sid}`,
      connected: false,
      data: {},
      emit: () => {},
      join: () => {},
      to: (room: string) => ({ emit: (event: string, payload: any) => this.nsp.to(room).emit(event, payload) }),
    } as unknown as Socket
    await handleAbort(
      this.nsp,
      fakeSocket,
      sid,
      this.sessionMap,
      this.bridge,
      this.runQueuedItem.bind(this),
    )
    this.emitExternalEvent(sid, 'run.failed', {
      event: 'run.failed',
      error: reason,
    })
  }

  emitExternalEvent(sessionId: string, event: string, payload: any) {
    const tagged = { ...payload, session_id: sessionId }
    const profile = this.resolvePetEventProfile(sessionId, tagged)
    this.observePetEvent(profile, event, tagged)
    const state = this.sessionMap.get(sessionId)
    if (state?.isWorking) {
      state.events.push({ event, data: tagged })
      if (state.events.length > 200) state.events.splice(0, state.events.length - 200)
    }
    this.nsp.to(`session:${sessionId}`).emit(event, tagged)
    const waiters = this.runWaiters.get(sessionId)
    if (waiters) {
      for (const waiter of waiters) waiter(event, tagged)
    }
  }

  markExternalRunCompleted(sessionId: string, event: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state) return
    state.isWorking = false
    state.abortController = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.events = []
    state.responseRun = undefined
    state.profile = undefined
    logger.info('[chat-run-socket] external run completed for session %s (%s)', sessionId, event)
    if (state.queue.length > 0) {
      const socket = this.socketForQueuedRun(sessionId, state.queue[0])
      if (socket) this.dequeueNextQueuedRun(socket, sessionId)
    }
  }

  clearSessionHistory(sessionId: string): { deleted: number; hadMemoryState: boolean } {
    const deleted = clearSessionMessages(sessionId)
    const state = this.sessionMap.get(sessionId)
    const hadMemoryState = Boolean(state)
    const messagePageLimit = state?.messagePageLimit
    if (state) {
      state.abortController?.abort()
      if (state.isWorking && isBridgeRunSource(state.source)) {
        const profile = state.profile
        void this.bridge.interrupt(sessionId, 'Session cleared', profile)
          .catch(err => logger.warn(err, '[chat-run-socket] failed to interrupt bridge run while clearing session %s', sessionId))
      }
      state.messages = []
      state.messageTotal = 0
      state.messageLoadedCount = 0
      state.hasMoreBefore = false
      state.inputTokens = 0
      state.outputTokens = 0
      state.contextTokens = 0
      state.events = []
      state.queue = []
      state.bridgePendingAssistantContent = undefined
      state.bridgePendingReasoningContent = undefined
      state.bridgePendingToolCallMarkup = undefined
      state.bridgeOutput = undefined
      state.bridgePendingTools = undefined
      state.bridgeCompressionResults = undefined
      state.responseRun = undefined
      state.activeRunMarker = undefined
      state.runId = undefined
      state.abortController = undefined
      state.isAborting = false
      state.isWorking = false
      state.profile = undefined
      this.sessionMap.delete(sessionId)
    }
    this.nsp.emit('session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: 'clear',
      ok: true,
      action: 'clear',
      clearHistory: true,
      source: 'mcu',
      deleted,
      memory_cleared: hadMemoryState,
    })
    this.nsp.emit('resumed', {
      session_id: sessionId,
      messages: [],
      messageTotal: 0,
      messageLoadedCount: 0,
      messagePageLimit,
      hasMoreBefore: false,
      isWorking: false,
      isAborting: false,
      events: [],
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      queueLength: 0,
      queueMessages: [],
    })
    this.nsp.emit('run.queued', {
      event: 'run.queued',
      session_id: sessionId,
      queue_length: 0,
      queued_messages: [],
    })
    logger.info({ sessionId, deleted, hadMemoryState }, '[chat-run-socket] cleared session history and memory state')
    return { deleted, hadMemoryState }
  }

  private socketForQueuedRun(sessionId: string, next?: QueuedRun): Socket | null {
    if (next?.originSocketId) {
      const origin = this.nsp.sockets.get(next.originSocketId)
      if (origin) return origin
    }
    const room = this.nsp.adapter.rooms.get(`session:${sessionId}`)
    if (room) {
      for (const socketId of room) {
        const socket = this.nsp.sockets.get(socketId)
        if (socket) return socket
      }
    }
    return this.nsp.sockets.values().next().value || null
  }

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
    const profile = this.resolvePetEventProfile(sessionId, tagged)
    this.observePetEvent(profile, event, tagged)
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

  private resolvePetEventProfile(sessionId: string, payload: Record<string, unknown>): string {
    const payloadProfile = typeof payload.profile === 'string' ? payload.profile.trim() : ''
    if (payloadProfile) return payloadProfile
    const stateProfile = this.sessionMap.get(sessionId)?.profile
    if (stateProfile) return stateProfile
    const storedProfile = getSession(sessionId)?.profile
    return storedProfile || 'default'
  }

  private observePetEvent(profile: string, event: string, payload: Record<string, unknown>): void {
    try {
      observeRunChatPetEvent(profile, event, payload)
    } catch (err) {
      logger.debug(err, '[chat-run-socket] failed to update pet state')
    }
  }
}
