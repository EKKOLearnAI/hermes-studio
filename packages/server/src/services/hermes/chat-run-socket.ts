/**
 * Chat run via Socket.IO — namespace /chat-run.
 *
 * Replaces HTTP POST + SSE. Socket.IO decouples message handling
 * from connection lifecycle: the server continues streaming upstream
 * events even after the client disconnects or refreshes.
 *
 * Uses Socket.IO rooms keyed by session_id. On client reconnect,
 * the client emits 'resume' to rejoin its session room.
 */
import type { Server, Socket } from 'socket.io'
import { EventSource } from 'eventsource'
import { setRunSession } from '../../routes/hermes/proxy-handler'
import { updateUsage } from '../../db/hermes/usage-store'
import {
  getSession,
  getSessionDetail,
  createSession,
  addMessage,
  updateSessionStats,
  useLocalSessionStore,
} from '../../db/hermes/session-store'
import { getDb } from '../../db/index'
import { getSessionDetailFromDb } from '../../db/hermes/sessions-db'
import { getModelContextLength } from './model-context'
import { ChatContextCompressor, countTokens, SUMMARY_PREFIX } from '../../lib/context-compressor'
import { getCompressionSnapshot } from '../../db/hermes/compression-snapshot'
import { logger } from '../logger'

const compressor = new ChatContextCompressor()

// --- Session state tracking ---

interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  codex_reasoning_items?: string | null
}

interface SessionState {
  messages: SessionMessage[]
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  abortController?: AbortController
  runId?: string
  /** Ephemeral session ID used for Hermes (one per run) */
  hermesSessionId?: string
  profile?: string
  inputTokens?: number
  outputTokens?: number
}

// --- ChatRunSocket ---

export class ChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private gatewayManager: any
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
      const { getToken } = await import('../auth')
      const serverToken = await getToken()
      if (serverToken && token !== serverToken) {
        return next(new Error('Authentication failed'))
      }
    }
    next()
  }

  // --- Connection handler ---

  private onConnection(socket: Socket) {
    const profile = (socket.handshake.query?.profile as string) || 'default'

    socket.on('run', async (data: {
      input: string
      session_id?: string
      model?: string
      instructions?: string
    }) => {
      await this.handleRun(socket, data, profile)
    })

    socket.on('resume', async (data: { session_id?: string }) => {
      if (!data.session_id) return
      const sid = data.session_id
      const room = `session:${sid}`
      socket.join(room)

      let state = this.sessionMap.get(sid)

      // Not in memory — load from DB
      if (!state) {
        try {
          const detail = useLocalSessionStore()
            ? getSessionDetail(sid)
            : await getSessionDetailFromDb(sid)
          const messages = detail?.messages?.length
            ? detail.messages
              .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined)
              .map(m => {
                const msg: any = {
                  id: m.id,
                  session_id: sid,
                  role: m.role,
                  content: m.content || '',
                  timestamp: m.timestamp,
                }
                if (m.tool_calls?.length) msg.tool_calls = m.tool_calls
                if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
                if (m.tool_name) msg.tool_name = m.tool_name
                if (m.reasoning) msg.reasoning = m.reasoning
                return msg
              })
            : []

          // Calculate context tokens — aware of compression snapshot
          let inputTokens: number
          const snapshot = getCompressionSnapshot(sid)
          if (snapshot) {
            const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
            inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
              newMessages.reduce((sum, m) => sum + countTokens(m.content || ''), 0)
          } else {
            inputTokens = messages.reduce((sum, m) => sum + countTokens(m.content || ''), 0)
          }
          const outputTokens = messages
            .filter(m => m.role === 'assistant')
            .reduce((sum, m) => sum + countTokens(m.content || ''), 0)
          state = {
            messages,
            isWorking: false,
            events: [],
            inputTokens,
            outputTokens,
          }
          this.sessionMap.set(sid, state)
          logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
        } catch (err) {
          logger.warn(err, '[chat-run-socket] failed to load session %s from DB on resume', sid)
          state = { messages: [], isWorking: false, events: [] }
          this.sessionMap.set(sid, state)
        }
      }

      // Reply with messages, working status + events (if working)
      socket.emit('resumed', {
        session_id: sid,
        messages: state.messages,
        isWorking: state.isWorking,
        events: state.isWorking ? state.events : [],
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      })

      logger.info('[chat-run-socket] socket %s resumed session %s (working: %s, messages: %d)',
        socket.id, sid, state.isWorking, state.messages.length)
    })

    socket.on('abort', (data: { session_id?: string }) => {
      if (data.session_id) {
        this.handleAbort(data.session_id)
      }
    })
  }

  // --- Run handler ---

  private async handleRun(
    socket: Socket,
    data: { input: string; session_id?: string; model?: string; instructions?: string },
    profile: string,
  ) {
    const { input, session_id, model, instructions } = data
    const upstream = this.gatewayManager.getUpstream(profile).replace(/\/$/, '')
    const apiKey = this.gatewayManager.getApiKey(profile) || undefined

    // Generate ephemeral session ID for Hermes (fresh session per run)
    const hermesSessionId = session_id
      ? `eph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      : undefined

    const now = Math.floor(Date.now() / 1000)

    // Mark working immediately on run start, and append user message
    if (session_id) {
      const state = this.getOrCreateSession(session_id)
      state.isWorking = true
      state.hermesSessionId = hermesSessionId
      state.profile = profile
      state.messages.push({
        id: state.messages.length + 1,
        session_id,
        role: 'user',
        content: input,
        timestamp: now,
      })

      // Create session in local DB if it doesn't exist
      if (!getSession(session_id)) {
        const preview = input.replace(/[\r\n]/g, ' ').substring(0, 100)
        createSession({ id: session_id, profile, model, title: preview })
      }

      // Write user message to local DB immediately
      addMessage({
        session_id,
        role: 'user',
        content: input,
        timestamp: now,
      })

      socket.join(`session:${session_id}`)
    }

    // Emit helper: tag every payload with session_id
    const emit = (event: string, payload: any) => {
      const tagged = session_id ? { ...payload, session_id } : payload
      if (session_id) {
        this.nsp.to(`session:${session_id}`).emit(event, tagged)
      } else if (socket.connected) {
        socket.emit(event, tagged)
      }
    }

    try {
      // Build upstream request body
      const body: Record<string, any> = { input }
      if (hermesSessionId) body.session_id = hermesSessionId
      if (model) body.model = model
      if (instructions) body.instructions = instructions

      // Build conversation_history from DB if session_id is provided
      if (session_id) {
        try {
          const detail = useLocalSessionStore()
            ? getSessionDetail(session_id)
            : await getSessionDetailFromDb(session_id)
          if (detail?.messages?.length) {
            // Filter valid messages
            const validMessages = detail.messages.filter(m =>
              (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined
            )

            // Exclude the last user message (just added in handleRun)
            const lastUserMsgIndex = [...validMessages].reverse().findIndex(m => m.role === 'user')
            let history: Array<{
              role: string
              content: string
              tool_calls?: any[]
              tool_call_id?: string
              name?: string
            }> = (lastUserMsgIndex >= 0
                ? validMessages.slice(0, validMessages.length - lastUserMsgIndex - 1)
                : validMessages
              ).map(m => {
                const msg: any = { role: m.role, content: m.content || '' }
                if (m.tool_calls?.length) msg.tool_calls = m.tool_calls
                if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
                if (m.tool_name) msg.name = m.tool_name
                return msg
              })

            // Context compression with snapshot awareness
            const contextLength = getModelContextLength(profile)
            const triggerTokens = Math.floor(contextLength / 2)
            const cState = this.getOrCreateSession(session_id)

            // Calculate inputTokens + outputTokens from DB (unified method)
            const assembledTokens = await this.calcAndUpdateUsage(session_id, cState, emit)
            const totalTokens = assembledTokens.inputTokens + assembledTokens.outputTokens
            // Step 1: Check existing snapshot — if present, assemble summary + new messages
            const snapshot = session_id ? getCompressionSnapshot(session_id) : null
            if (snapshot) {
              const newMessages = history.slice(snapshot.lastMessageIndex + 1)
              logger.info('[context-compress] session=%s: snapshot at %d, %d new messages, assembled ~%d tokens (threshold %d)',
                session_id, snapshot.lastMessageIndex, newMessages.length, totalTokens, triggerTokens)
              if (totalTokens <= triggerTokens) {
                // Under threshold — use assembled context directly, no LLM call needed
                history = [
                  { role: 'user', content: SUMMARY_PREFIX + '\n\n' + snapshot.summary },
                  ...newMessages,
                ]
              } else {
                this.pushState(session_id, 'compression.started', {
                  event: 'compression.started',
                  message_count: newMessages.length,
                  token_count: totalTokens,
                })
                emit('compression.started', {
                  event: 'compression.started',
                  message_count: newMessages.length,
                  token_count: totalTokens,
                })

                try {
                  const result = await compressor.compress(
                    history, upstream, apiKey, session_id, contextLength,
                  )
                  const afterTokens = await this.calcAndUpdateUsage(session_id, cState, emit)
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens: totalTokens,
                    afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })
                  logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)', session_id, result.messages.length, afterTokens.inputTokens + afterTokens.outputTokens, totalTokens)

                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens: totalTokens,
                    afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })

                  history = result.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id,
                    name: m.name,
                  }))
                  // Update usage from DB (snapshot now updated by compressor)
                  await this.calcAndUpdateUsage(session_id, cState, emit)
                } catch (err: any) {
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: newMessages.length,
                    resultMessages: newMessages.length,
                    beforeTokens: totalTokens,
                    afterTokens: totalTokens,
                    summaryTokens: 0,
                    verbatimCount: newMessages.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                  logger.warn(err, '[chat-run-socket] compression failed for session %s, using assembled context', session_id)
                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: newMessages.length,
                    resultMessages: newMessages.length,
                    beforeTokens: totalTokens,
                    afterTokens: totalTokens,
                    summaryTokens: 0,
                    verbatimCount: newMessages.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                }
              }
            } else if (history.length > 4) {
              // No snapshot — check if raw history exceeds threshold

              if (totalTokens <= triggerTokens) {
                // Under threshold — use raw history as-is
                logger.info('[context-compress] session=%s: %d messages, ~%d tokens — under threshold, skip', session_id, history.length, totalTokens)
              } else {
                // Over threshold — full LLM compression
                logger.info('[context-compress] BEFORE session=%s: %d messages, ~%d tokens (threshold %d)', session_id, history.length, totalTokens, triggerTokens)

                this.pushState(session_id, 'compression.started', {
                  event: 'compression.started',
                  message_count: history.length,
                  token_count: totalTokens,
                })
                emit('compression.started', {
                  event: 'compression.started',
                  message_count: history.length,
                  token_count: totalTokens,
                })

                try {
                  const result = await compressor.compress(
                    history, upstream, apiKey, session_id, contextLength,
                  )
                  const cState = this.getOrCreateSession(session_id)
                  const afterTokens = await this.calcAndUpdateUsage(session_id, cState, emit)
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens: totalTokens,
                    afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })
                  logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)', session_id, result.messages.length, afterTokens.inputTokens + afterTokens.outputTokens, totalTokens)

                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens: totalTokens,
                    afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })

                  history = result.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id,
                    name: m.name,
                  }))
                  await this.calcAndUpdateUsage(session_id, cState, emit)
                } catch (err: any) {
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: history.length,
                    resultMessages: history.length,
                    beforeTokens: totalTokens,
                    afterTokens: totalTokens,
                    summaryTokens: 0,
                    verbatimCount: history.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                  logger.warn(err, '[chat-run-socket] compression failed for session %s, using raw history', session_id)
                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: history.length,
                    resultMessages: history.length,
                    beforeTokens: totalTokens,
                    afterTokens: totalTokens,
                    summaryTokens: 0,
                    verbatimCount: history.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                }
              }
            }

            body.conversation_history = history
          }
        } catch (err) {
          logger.warn(err, '[chat-run-socket] failed to load conversation history for session %s', session_id)
        }
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const res = await fetch(`${upstream}/v1/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        emit('run.failed', { event: 'run.failed', error: `Upstream ${res.status}: ${text}` })
        return
      }

      const runData = await res.json() as any
      const runId = runData.run_id
      if (!runId) {
        emit('run.failed', { event: 'run.failed', error: 'No run_id in upstream response' })
        return
      }

      if (session_id) {
        setRunSession(runId, session_id)
      }

      const abortController = new AbortController()
      if (session_id) {
        const state = this.getOrCreateSession(session_id)
        state.isWorking = true
        state.runId = runId
        state.abortController = abortController
      }

      emit('run.started', { event: 'run.started', run_id: runId, status: runData.status })

      // Stream upstream events via EventSource — survives socket disconnect
      const eventsUrl = new URL(`${upstream}/v1/runs/${runId}/events`)
      if (apiKey) eventsUrl.searchParams.set('token', apiKey)

      const source = new EventSource(eventsUrl.toString())

      source.onmessage = (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(event.data as string)

          // Track messages into sessionMap
          if (session_id) {
            const state = this.sessionMap.get(session_id)
            if (state) {
              const msgs = state.messages
              const last = msgs[msgs.length - 1]

              switch (parsed.event) {
                case 'message.delta': {
                  if (last?.role === 'assistant' && last.finish_reason == null) {
                    last.content += (parsed.delta || '')
                  } else {
                    msgs.push({
                      id: msgs.length + 1,
                      session_id,
                      role: 'assistant',
                      content: parsed.delta || '',
                      timestamp: Math.floor(Date.now() / 1000),
                    })
                  }
                  break
                }
                case 'reasoning.delta':
                case 'thinking.delta': {
                  const text = parsed.text || parsed.delta || ''
                  if (!text) break
                  if (last?.role === 'assistant' && last.finish_reason == null) {
                    last.reasoning = (last.reasoning || '') + text
                  } else {
                    msgs.push({
                      id: msgs.length + 1,
                      session_id,
                      role: 'assistant',
                      content: '',
                      reasoning: text,
                      timestamp: Math.floor(Date.now() / 1000),
                    })
                  }
                  break
                }
                case 'tool.started': {
                  if (last?.role === 'assistant' && last.finish_reason == null) {
                    last.finish_reason = 'tool_calls'
                  }
                  msgs.push({
                    id: msgs.length + 1,
                    session_id,
                    role: 'tool',
                    content: '',
                    tool_call_id: parsed.tool_call_id || null,
                    tool_name: parsed.tool || parsed.name || null,
                    timestamp: Math.floor(Date.now() / 1000),
                  })
                  break
                }
                case 'tool.completed': {
                  const toolMsg = [...msgs].reverse().find(m => m.role === 'tool' && !m.content)
                  if (toolMsg && parsed.output) {
                    toolMsg.content = typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output)
                  }
                  break
                }
                case 'run.completed': {
                  if (last?.role === 'assistant' && last.finish_reason == null) {
                    last.finish_reason = parsed.finish_reason || 'stop'
                  }
                  // Finalize assistant message — if no content was streamed, use output
                  if (parsed.output && !runProducedAssistantText(msgs)) {
                    if (last?.role === 'assistant') {
                      last.content = parsed.output
                    } else {
                      msgs.push({
                        id: msgs.length + 1,
                        session_id,
                        role: 'assistant',
                        content: parsed.output,
                        timestamp: Math.floor(Date.now() / 1000),
                      })
                    }
                  }
                  break
                }
              }
            }
          }

          // Usage will be calculated after syncFromHermes completes (in markCompleted)

          emit(parsed.event || 'message', parsed)

          if (parsed.event === 'run.completed' || parsed.event === 'run.failed') {
            source.close()
            if (session_id) this.markCompleted(session_id, { event: parsed.event, run_id: parsed.run_id })
          }
        } catch { /* not JSON, skip */ }
      }

      source.onerror = () => {
        source.close()
        emit('run.failed', { event: 'run.failed', error: 'EventSource connection lost' })
        if (session_id) this.markCompleted(session_id, { event: 'run.failed' })
      }
    } catch (err: any) {
      emit('run.failed', { event: 'run.failed', error: err.message })
      if (session_id) this.markCompleted(session_id, { event: 'run.failed' })
    }
  }

  // --- Abort handler ---

  private handleAbort(sessionId: string) {
    const state = this.sessionMap.get(sessionId)
    if (state?.isWorking && state.abortController) {
      state.abortController.abort()
      this.markCompleted(sessionId, { event: 'run.failed', run_id: state.runId })
    }
  }

  /** Mark a session run as completed/failed so reconnecting clients get notified */
  private markCompleted(sessionId: string, _info: { event: string; run_id?: string }) {
    const state = this.sessionMap.get(sessionId)
    if (state) {
      state.isWorking = false
      state.abortController = undefined
      state.runId = undefined
      state.events = []

      // Sync messages from Hermes ephemeral session to local DB
      if (useLocalSessionStore() && state.hermesSessionId) {
        const hermesId = state.hermesSessionId
        const prof = state.profile
        state.hermesSessionId = undefined
        state.profile = undefined
        this.syncFromHermes(sessionId, hermesId, prof)
      }
    }
  }

  /**
   * Calculate usage from DB and update state + emit to clients.
   * @returns { inputTokens, outputTokens } for the caller to use
   */
  private async calcAndUpdateUsage(
    sid: string, state: SessionState, emit: (event: string, payload: any) => void,
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    try {
      const detail = useLocalSessionStore()
        ? getSessionDetail(sid)
        : await getSessionDetailFromDb(sid)
      const msgs = detail?.messages
        ?.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool') || []

      const snapshot = getCompressionSnapshot(sid)
      let inputTokens: number
      if (snapshot && msgs.length) {
        const newMessages = msgs.slice(snapshot.lastMessageIndex + 1)
        inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
          newMessages.reduce((sum, m) => sum + countTokens(m.content || ''), 0)
      } else {
        inputTokens = msgs.reduce((sum, m) => sum + countTokens(m.content || ''), 0)
      }

      const outputTokens = msgs
        .filter(m => m.role === 'assistant')
        .reduce((sum, m) => sum + countTokens(m.content || ''), 0)
      state.inputTokens = inputTokens
      state.outputTokens = outputTokens
      emit('usage.updated', {
        event: 'usage.updated',
        session_id: sid,
        inputTokens,
        outputTokens,
      })
      return { inputTokens, outputTokens }
    } catch (err: any) {
      logger.warn(err, '[chat-run-socket] failed to calculate usage for session %s', sid)
      return { inputTokens: 0, outputTokens: 0 }
    }
  }

  /**
   * Read complete messages from Hermes state.db for the ephemeral session
   * and write to local DB. This gives us tool results that SSE events don't include.
   * After sync, enqueues the ephemeral session for deletion.
   */
  private syncFromHermes(localSessionId: string, hermesSessionId: string, profile?: string) {
    getSessionDetailFromDb(hermesSessionId)
      .then((detail) => {
        if (!detail || !detail.messages?.length) {
          logger.warn('[chat-run-socket] syncFromHermes: no data for Hermes session %s', hermesSessionId)
          return
        }

        // Skip user messages — already written to local DB in handleRun
        const toInsert = detail.messages.filter(m => m.role !== 'user')

        // Build tool_call_id → function.name lookup from assistant messages
        // (Hermes stores tool_name as NULL, name lives inside tool_calls JSON)
        const toolNameMap = new Map<string, string>()
        for (const msg of detail.messages) {
          if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              const id = tc.id || tc.call_id || tc.tool_call_id
              const name = tc.function?.name || tc.name
              if (id && name) toolNameMap.set(id, name)
            }
          }
        }

        if (toInsert.length > 0) {
          for (const msg of toInsert) {
            // Resolve tool_name from assistant's tool_calls if missing
            let toolName = msg.tool_name || null
            if (!toolName && msg.tool_call_id) {
              toolName = toolNameMap.get(msg.tool_call_id) || null
            }
            addMessage({
              session_id: localSessionId,
              role: msg.role,
              content: msg.content || '',
              tool_call_id: msg.tool_call_id || null,
              tool_calls: msg.tool_calls || null,
              tool_name: toolName,
              timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
              token_count: msg.token_count || null,
              finish_reason: msg.finish_reason || null,
              reasoning: msg.reasoning || null,
              reasoning_details: msg.reasoning_details || null,
              reasoning_content: msg.reasoning_content || null,
              codex_reasoning_items: msg.codex_reasoning_items || null,
            })
          }
          logger.info('[chat-run-socket] syncFromHermes: synced %d messages to local session %s', toInsert.length, localSessionId)
        }

        updateSessionStats(localSessionId)

        // Record usage from Hermes session
        updateUsage(localSessionId, {
          inputTokens: detail.input_tokens,
          outputTokens: detail.output_tokens,
          cacheReadTokens: detail.cache_read_tokens,
          cacheWriteTokens: detail.cache_write_tokens,
          reasoningTokens: detail.reasoning_tokens,
          model: detail.model,
          profile: profile || 'default',
        })

        // Calculate usage from DB now that data is complete
        // Use inputTokens already set by compression path if available
        const state = this.sessionMap.get(localSessionId)
        if (state) {
          const emit = (event: string, payload: any) => {
            this.nsp.to(`session:${localSessionId}`).emit(event, { ...payload, session_id: localSessionId })
          }
          this.calcAndUpdateUsage(localSessionId, state, emit)
        }

        // Enqueue ephemeral session for deferred deletion
        this.enqueueEphemeralDelete(hermesSessionId, profile)
      })
      .catch((err: any) => {
        logger.warn(err, '[chat-run-socket] syncFromHermes failed for session %s (hermesId: %s, profile: %s)', localSessionId, hermesSessionId, profile || 'default')
      })
  }

  /** Enqueue an ephemeral Hermes session for deferred deletion */
  private enqueueEphemeralDelete(hermesSessionId: string, profile?: string) {
    try {
      const db = getDb()
      if (!db) return
      const now = Date.now()
      db.prepare(
        `INSERT INTO gc_pending_session_deletes (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, 'pending', 0, NULL, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
      ).run(hermesSessionId, profile || 'default', now, now, now)
      logger.info('[chat-run-socket] enqueued ephemeral session %s for deletion', hermesSessionId)
    } catch { /* best-effort */ }
  }

  /** Get or create session state in sessionMap */
  private getOrCreateSession(sessionId: string): SessionState {
    let state = this.sessionMap.get(sessionId)
    if (!state) {
      state = { messages: [], isWorking: false, events: [] }
      this.sessionMap.set(sessionId, state)
    }
    return state
  }

  /** Append a state event for a session (used for replay on reconnect) */
  private pushState(sessionId: string, event: string, data: any) {
    const state = this.getOrCreateSession(sessionId)
    state.events.push({ event, data })
  }

  /** Replace the last state with the same event name, or append if different */
  private replaceState(sessionId: string, event: string, data: any) {
    const state = this.sessionMap.get(sessionId)
    if (state) {
      const idx = state.events.findIndex(s => s.event === event)
      if (idx >= 0) {
        state.events[idx] = { event, data }
        return
      }
    }
    this.pushState(sessionId, event, data)
  }
}

/** Check if any assistant message in the list has non-empty content */
function runProducedAssistantText(messages: SessionMessage[]): boolean {
  return messages.some(m => m.role === 'assistant' && m.content?.trim())
}
