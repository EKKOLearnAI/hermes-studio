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
import { getSystemPrompt } from '../../lib/llm-prompt'
import {
  getSession,
  getSessionDetail,
  getSessionDetailPaginated,
  createSession,
  addMessage,
  updateSessionStats,
  useLocalSessionStore,
} from '../../db/hermes/session-store'
import { getSessionDetailFromDb } from '../../db/hermes/sessions-db'
import { getModelContextLength } from './model-context'
import { ChatContextCompressor, countTokens, SUMMARY_PREFIX } from '../../lib/context-compressor'
import { getCompressionSnapshot } from '../../db/hermes/compression-snapshot'
import { parseAnthropicContentArray } from '../../lib/llm-json'
import { updateUsage } from '../../db/hermes/usage-store'
import { logger } from '../logger'

/**
 * Content block types for Anthropic-compatible message format
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string }
  | { type: 'file'; name: string; path: string; media_type?: string }

/**
 * Convert ContentBlock[] to string for display/storage
 * - string → 直接返回
 * - ContentBlock[] → 返回 JSON 字符串
 */
function contentBlocksToString(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return JSON.stringify(input)
}

/**
 * Extract text content from ContentBlock[] for title preview
 */
function extractTextForPreview(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input

  return input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Check if input is ContentBlock array
 */
function isContentBlockArray(input: any): input is ContentBlock[] {
  return Array.isArray(input) && input.length > 0 && ('type' in input[0])
}

/**
 * Convert ContentBlock[] to multimodal format for /v1/responses API.
 *
 * - text → { type: "input_text", text }
 * - image → { type: "input_image", image_url: "data:image/...;base64,..." }
 * - file → text mention [File: name]
 */
async function convertContentBlocks(blocks: ContentBlock[]): Promise<Array<{ type: string; text?: string; image_url?: string }>> {
  const parts: Array<{ type: string; text?: string; image_url?: string }> = []
  const fs = await import('fs/promises')
  const path = await import('path')

  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      try {
        const buf = await fs.readFile(block.path)
        const ext = path.extname(block.path).toLowerCase().replace('.', '')
        const mime = ext === 'jpg' ? 'jpeg' : ext || 'png'
        const base64 = buf.toString('base64')
        parts.push({ type: 'input_image', image_url: `data:image/${mime};base64,${base64}` })
      } catch {
        parts.push({ type: 'input_text', text: `[Image: ${block.path}]` })
      }
    } else if (block.type === 'file') {
      parts.push({ type: 'input_text', text: `[File: ${block.name || block.path}]` })
    }
  }

  return parts
}

const compressor = new ChatContextCompressor()

// --- Helper: Convert OpenAI format to Anthropic format ---
function convertHistoryFormat(messages: any[]): any[] {
  const result: any[] = []

  for (const m of messages) {
    const role = m.role
    const content = m.content || ''
    delete m.reasoning_content
    if (role === 'tool') {
      // Convert tool message to tool_result in user message
      // Follow Hermes official format: content is a string (not array)
      let pushItem = { ...m }
      pushItem.role = 'user'
      pushItem.content = `[Tool result: ${content}]`
      result.push(pushItem)
      continue
    }

    // Regular user message
    if (role === 'user') {
      // Format: { role: 'user', content: [{ type: 'text', text: '...' }] }
      if (typeof content === 'string') {
        result.push({ role: 'user', content: content })
      } else if (Array.isArray(content)) {
        // Extract text from content blocks for history
        const textParts = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
        result.push({ role: 'user', content: textParts || JSON.stringify(content) })
      }
      continue
    }
    if (role === 'assistant') {
      result.push({ ...m })
      continue
    }
  }
  return result
}

// --- Session state tracking ---

interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  runMarker?: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
}

interface QueuedRun {
  queue_id: string
  input: string | ContentBlock[]
  model?: string
  instructions?: string
  profile: string
}

interface SessionState {
  messages: SessionMessage[]
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  abortController?: AbortController
  runId?: string
  profile?: string
  inputTokens?: number
  outputTokens?: number
  isAborting?: boolean
  queue: QueuedRun[]
  responseRun?: ResponseRunState
}

interface ResponseRunState {
  runMarker?: string
  responseId?: string
  insertedKeys: Set<string>
  toolCalls: Map<string, any>
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
      input: string | ContentBlock[]
      session_id?: string
      model?: string
      instructions?: string
      queue_id?: string
    }) => {
      if (data.session_id) {
        const state = this.getOrCreateSession(data.session_id)
        if (state.isWorking) {
          state.queue.push({
            queue_id: data.queue_id || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            input: data.input,
            model: data.model,
            instructions: data.instructions,
            profile,
          })
          this.nsp.to(`session:${data.session_id}`).emit('run.queued', {
            event: 'run.queued',
            session_id: data.session_id,
            queue_length: state.queue.length,
          })
          logger.info('[chat-run-socket] queued run for session %s (queue: %d)', data.session_id, state.queue.length)
          return
        }
      }
      await this.handleRun(socket, data, profile)
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
      const room = `session:${sid}`
      socket.join(room)
      this.resumeSession(socket, sid)
    })

    socket.on('abort', (data: { session_id?: string }) => {
      if (data.session_id) {
        void this.handleAbort(socket, data.session_id)
      }
    })
  }
  private handleMessage(messages: SessionMessage[], sid: string): any[] {
    let _messages = []
    try {
      _messages = messages
        .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined)
        .map((m, idx, arr) => {
          const msg: any = {
            id: m.id,
            session_id: sid,
            role: m.role,
            content: m.content || '',
            reasoning: m.reasoning || '',
            timestamp: m.timestamp,
          }
          // Convert Anthropic format content to OpenAI format
          // Check if content is a stringified array (Hermes Gateway behavior) - only for assistant messages
          if (m.role === 'assistant' && typeof m.content === 'string') {
            // Handle double-serialized content: "[{'type': 'text', ...}]" -> "[{'type': 'text', ...}]"
            let contentToParse = m.content
            const trimmed = m.content.trim()
            if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
              contentToParse = trimmed.slice(1, -1)
              logger.info('[chat-run-socket] resume message %s: double-serialized, removed outer quotes', m.id)
            }

            if (contentToParse.startsWith('[') && contentToParse.endsWith(']')) {
              try {
                // Use robust LLM JSON parser
                const parsedContent = parseAnthropicContentArray(contentToParse)
                const textBlocks: string[] = []
                const toolCalls: any[] = []
                let reasoningContent: string | null = null

                for (const block of parsedContent) {
                  if (block.type === 'thinking') {
                    reasoningContent = block.thinking || null
                  } else if (block.type === 'text') {
                    textBlocks.push(block.text || '')
                  } else if (block.type === 'tool_use') {
                    toolCalls.push({
                      id: block.id,
                      type: 'function',
                      function: {
                        name: block.name,
                        arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : (block.input ?? '{}')
                      }
                    })
                  }
                }

                msg.content = textBlocks.join('') || ''
                if (toolCalls.length > 0) {
                  msg.tool_calls = toolCalls
                }
                if (reasoningContent) {
                  msg.reasoning = reasoningContent
                }
              } catch (e) {
                logger.warn(e, '[chat-run-socket] failed to parse array content for message %s, keeping original', m.id)
                // Parsing failed, keep original content
                msg.content = m.content
              }
            }
          } else if (Array.isArray(m.content)) {
            const textBlocks: string[] = []
            const toolCalls: any[] = []
            let reasoningContent: string | null = null

            for (const block of m.content) {
              if (block.type === 'thinking') {
                reasoningContent = block.thinking
              } else if (block.type === 'text') {
                textBlocks.push(block.text)
              } else if (block.type === 'tool_use') {
                toolCalls.push({
                  id: block.id,
                  type: 'function',
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input ?? {})
                  }
                })
              }
            }

            msg.content = textBlocks.join('') || ''
            if (toolCalls.length > 0) {
              msg.tool_calls = toolCalls
            }
            if (reasoningContent) {
              msg.reasoning = reasoningContent
            }
          }

          if (m.tool_calls?.length) {
            // Filter out tool_calls with empty/invalid id and remove internal fields
            const cleanedToolCalls = m.tool_calls
              .filter((tc: any) => tc.id && tc.id.length > 0)
              .map((tc: any) => ({
                id: tc.id,
                type: tc.type,
                function: tc.function
              }))
            if (cleanedToolCalls.length > 0) {
              msg.tool_calls = cleanedToolCalls
            }
          }

          // For tool messages, ensure tool_call_id exists
          if (m.role === 'tool') {
            let callId = m.tool_call_id
            if (!callId || callId.length === 0) {
              // Try to reconstruct tool_call_id from previous assistant message
              const prevMsg = arr[idx - 1]
              if (prevMsg?.role === 'assistant' && prevMsg.tool_calls?.length) {
                // Find matching tool_call by tool_name
                const tc = prevMsg.tool_calls.find((t: any) => t.function?.name === m.tool_name)
                if (tc?.id) {
                  callId = tc.id
                }
              }
            }
            // Skip tool message if no valid tool_call_id
            if (!callId || callId.length === 0) {
              return null
            }
            msg.tool_call_id = callId
          }

          if (m.tool_name) msg.tool_name = m.tool_name
          if (m.reasoning) msg.reasoning = m.reasoning
          return msg
        })
        .filter(m => m !== null)
    } catch (error) {

    }
    return _messages
  }
  private async resumeSession(socket: Socket, sid: string) {
    let state = this.sessionMap.get(sid)
    if (!state) {
      state = await this.loadSessionStateFromDb(sid)
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

  private async loadSessionStateFromDb(sid: string): Promise<SessionState> {
    try {
      const detail = useLocalSessionStore()
        ? getSessionDetailPaginated(sid)
        : await getSessionDetailFromDb(sid)
      const messages = detail?.messages ? this.handleMessage(detail.messages, sid) : []

      let inputTokens: number
      let outputTokens: number
      const snapshot = getCompressionSnapshot(sid)
      if (snapshot) {
        const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
        inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
          newMessages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = newMessages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      } else {
        inputTokens = messages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = messages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      }

      logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
      return {
        messages,
        isWorking: false,
        events: [],
        inputTokens,
        outputTokens,
        queue: [],
      }
    } catch (err) {
      logger.warn(err, '[chat-run-socket] failed to load session %s from DB', sid)
      return { messages: [], isWorking: false, events: [], queue: [] }
    }
  }
  // --- Run handler ---

  private async handleRun(
    socket: Socket,
    data: { input: string | ContentBlock[]; session_id?: string; model?: string; instructions?: string },
    profile: string,
    skipUserMessage = false,
  ) {
    const { input, session_id, model, instructions } = data
    const upstream = this.gatewayManager.getUpstream(profile).replace(/\/$/, '')
    const apiKey = this.gatewayManager.getApiKey(profile) || undefined

    // Local marker used only to group in-memory messages for this streamed response.
    const runMarker = session_id
      ? `resp_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      : undefined

    const now = Math.floor(Date.now() / 1000)
    // Mark working immediately on run start, and append user message
    if (session_id) {
      let state = this.sessionMap.get(session_id)
      if (!state) {
        state = getSession(session_id)
          ? await this.loadSessionStateFromDb(session_id)
          : { messages: [], isWorking: false, events: [], queue: [] }
        this.sessionMap.set(session_id, state)
      }
      state.isWorking = true
      state.profile = profile

      if (!skipUserMessage) {
        // Convert ContentBlock[] to string for storage
        const inputStr = contentBlocksToString(input)
        state.messages.push({
          id: state.messages.length + 1,
          session_id,
          runMarker,
          role: 'user',
          content: inputStr,
          timestamp: now,
        })

        // Create session in local DB if it doesn't exist
        if (!getSession(session_id)) {
          const previewText = extractTextForPreview(input)
          const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
          createSession({ id: session_id, profile, model, title: preview })
        }

        // Write user message to local DB immediately
        addMessage({
          session_id,
          role: 'user',
          content: inputStr,
          timestamp: now,
        })
      } else {
        // Dequeued: write the user message into both memory and DB so the
        // backend transcript keeps the same run boundary as the client.
        const inputStr = contentBlocksToString(input)
        state.messages.push({
          id: state.messages.length + 1,
          session_id,
          runMarker,
          role: 'user',
          content: inputStr,
          timestamp: now,
        })
        if (!getSession(session_id)) {
          const previewText = extractTextForPreview(input)
          const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
          createSession({ id: session_id, profile, model, title: preview })
        }
        addMessage({
          session_id,
          role: 'user',
          content: inputStr,
          timestamp: now,
        })
      }

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
      if (model) body.model = model
      if (instructions) {
        body.instructions = `${getSystemPrompt()}\n${instructions}`
      } else {
        body.instructions = getSystemPrompt()
      }
      // Inject workspace context if set for this session
      if (session_id) {
        const sessionRow = getSession(session_id)
        if (sessionRow?.workspace) {
          const workspaceCtx = `[Current working directory: ${sessionRow.workspace}]`
          body.instructions = body.instructions
            ? `\n${workspaceCtx}\n${body.instructions}`
            : `\n${workspaceCtx}`
        }
      }
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
              reasoning_content?: string | null
            }> = (lastUserMsgIndex >= 0
              ? validMessages.slice(0, validMessages.length - lastUserMsgIndex - 1)
              : validMessages
            ).map((m, idx, arr) => {
              const msg: any = { role: m.role, content: m.content || '' }
              if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
              if (m.tool_calls?.length) {
                // Filter out tool_calls with empty/invalid id and remove internal fields
                const cleanedToolCalls = m.tool_calls
                  .filter((tc: any) => tc.id && tc.id.length > 0)
                  .map((tc: any) => ({
                    id: tc.id,
                    type: tc.type,
                    function: tc.function
                  }))
                if (cleanedToolCalls.length > 0) {
                  msg.tool_calls = cleanedToolCalls
                }
              }

              // For tool messages, ensure tool_call_id exists
              if (m.role === 'tool') {
                let callId = m.tool_call_id
                if (!callId || callId.length === 0) {
                  // Try to reconstruct tool_call_id from previous assistant message
                  const prevMsg = arr[idx - 1]
                  if (prevMsg?.role === 'assistant' && prevMsg.tool_calls?.length) {
                    const tc = prevMsg.tool_calls.find((t: any) => t.function?.name === m.tool_name)
                    if (tc?.id) {
                      callId = tc.id
                    }
                  }
                }
                // Skip tool message if no valid tool_call_id
                if (!callId || callId.length === 0) {
                  return null
                }
                msg.tool_call_id = callId
              }

              if (m.tool_name) msg.name = m.tool_name
              return msg
            })
              .filter(m => m !== null)
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
              // triggerTokens
              if (totalTokens <= triggerTokens && newMessages.length <= 150) {
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
                    history, upstream, apiKey, session_id,
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

                  history = result.messages.map(m => {
                    const msg: any = {
                      role: m.role,
                      content: m.content,
                      tool_call_id: m.tool_call_id,
                      name: m.name,
                    }
                    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
                    // Filter tool_calls if present, remove internal fields
                    if (m.tool_calls?.length) {
                      const cleanedToolCalls = m.tool_calls
                        .filter((tc: any) => tc.id && tc.id.length > 0)
                        .map((tc: any) => ({
                          id: tc.id,
                          type: tc.type,
                          function: tc.function
                        }))
                      if (cleanedToolCalls.length > 0) {
                        msg.tool_calls = cleanedToolCalls
                      }
                    }
                    return msg
                  })
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

              if (totalTokens <= triggerTokens && history.length <= 150) {
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
                    history, upstream, apiKey, session_id,
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

                  history = result.messages.map(m => {
                    const msg: any = {
                      role: m.role,
                      content: m.content,
                      tool_call_id: m.tool_call_id,
                      name: m.name,
                    }
                    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
                    // Filter tool_calls if present, remove internal fields
                    if (m.tool_calls?.length) {
                      const cleanedToolCalls = m.tool_calls
                        .filter((tc: any) => tc.id && tc.id.length > 0)
                        .map((tc: any) => ({
                          id: tc.id,
                          type: tc.type,
                          function: tc.function
                        }))
                      if (cleanedToolCalls.length > 0) {
                        msg.tool_calls = cleanedToolCalls
                      }
                    }
                    return msg
                  })
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
      // Convert input from ContentBlock[] to multimodal message format for /v1/responses
      if (isContentBlockArray(input)) {
        const parts = await convertContentBlocks(input)
        body.input = [{ role: 'user', content: parts }]
      }

      // Debug: write history to JSON file for analysis (before conversion)

      // Convert conversation_history from OpenAI format to Anthropic format
      if (body.conversation_history && Array.isArray(body.conversation_history)) {
        body.conversation_history = convertHistoryFormat(body.conversation_history)
      }
      body.stream = true
      body.store = false

      const abortController = new AbortController()
      if (session_id) {
        const state = this.getOrCreateSession(session_id)
        state.isWorking = true
        state.runId = undefined
        state.abortController = abortController
      }

      const res = await fetch(`${upstream}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
        if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed' })
        emit('run.failed', { event: 'run.failed', error: `Upstream ${res.status}: ${text}`, queue_remaining: queueLen })
        if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
        return
      }
      if (!res.body) {
        const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
        if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed' })
        emit('run.failed', { event: 'run.failed', error: 'Upstream response stream missing', queue_remaining: queueLen })
        if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
        return
      }

      let responseId: string | undefined
      for await (const frame of readSseFrames(res.body)) {
        let parsed: any
        try {
          parsed = JSON.parse(frame.data)
        } catch {
          continue
        }
        const upstreamEvent = parsed.type || frame.event || parsed.event
        logger.info('[chat-run-socket] upstream response event: %s', upstreamEvent)

        if (session_id) {
          const state = this.sessionMap.get(session_id)
          if (state) {
            const mapped = this.applyResponseStreamEvent(state, session_id, runMarker, upstreamEvent, parsed)
            if (mapped) {
              if (mapped.runId) {
                responseId = mapped.runId
                state.runId = responseId
              }
              emit(mapped.event, mapped.payload)
            }
          }
        }

        if (upstreamEvent === 'response.completed' || upstreamEvent === 'response.failed') {
          if (session_id && this.sessionMap.get(session_id)?.isAborting) {
            logger.info({
              sessionId: session_id,
              runId: responseId,
              event: upstreamEvent,
            }, '[chat-run-socket][abort] suppressing upstream terminal event during abort')
            return
          }
          const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
          if (session_id) await this.markCompleted(socket, session_id, {
            event: upstreamEvent === 'response.completed' ? 'run.completed' : 'run.failed',
            run_id: responseId,
          })
          const finalOutput = parsed.response || parsed
          const finalText = extractResponseText(finalOutput)
          if (upstreamEvent === 'response.completed' && session_id) {
            const usage = finalOutput.usage || {}
            updateUsage(session_id, {
              inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
              outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
              cacheReadTokens: usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0,
              cacheWriteTokens: usage.cache_write_tokens ?? usage.cacheWriteTokens ?? 0,
              reasoningTokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
              model: finalOutput.model || '',
              profile: this.sessionMap.get(session_id)?.profile,
            })
          }
          const eventName = upstreamEvent === 'response.completed' ? 'run.completed' : 'run.failed'
          emit(eventName, {
            event: eventName,
            run_id: responseId || finalOutput.id,
            response_id: responseId || finalOutput.id,
            output: finalText,
            usage: finalOutput.usage,
            error: finalOutput.error || parsed.error,
            queue_remaining: queueLen,
          })
          if (session_id && queueLen > 0) {
            this.dequeueNextQueuedRun(socket, session_id)
          }
          return
        }
      }
      const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed', run_id: responseId })
      emit('run.failed', {
        event: 'run.failed',
        run_id: responseId,
        response_id: responseId,
        error: 'Response stream ended without a terminal event',
        queue_remaining: queueLen,
      })
      if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
    } catch (err: any) {
      const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) {
        void this.markCompleted(socket, session_id, { event: 'run.failed' }).then(() => {
          emit('run.failed', { event: 'run.failed', error: err.message, queue_remaining: queueLen })
          if (queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
        })
      } else {
        emit('run.failed', { event: 'run.failed', error: err.message })
      }
    }
  }

  private applyResponseStreamEvent(
    state: SessionState,
    sessionId: string,
    runMarker: string | undefined,
    eventType: string,
    parsed: any,
  ): { event: string; payload: any; runId?: string } | null {
    const run = this.getResponseRunState(state, runMarker)
    const now = () => Math.floor(Date.now() / 1000)

    if (eventType === 'response.created') {
      const response = parsed.response || parsed
      run.responseId = response.id || run.responseId
      return {
        event: 'run.started',
        runId: run.responseId,
        payload: {
          event: 'run.started',
          run_id: run.responseId,
          response_id: run.responseId,
          status: response.status || 'in_progress',
          queue_length: state.queue.length || 0,
        },
      }
    }

    if (eventType === 'response.output_text.delta') {
      const deltaText = parsed.delta || parsed.text || ''
      if (!deltaText) return null

      const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
      if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
        last.content += deltaText
      } else {
        state.messages.push({
          id: state.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: deltaText,
          timestamp: now(),
        })
      }
      return {
        event: 'message.delta',
        payload: {
          event: 'message.delta',
          run_id: run.responseId,
          response_id: run.responseId,
          delta: deltaText,
        },
      }
    }

    if (eventType === 'response.output_text.done') {
      // Just mark the last assistant message as complete.
      // Content is already accumulated correctly via deltas.
      const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
      if (last?.role === 'assistant' && last.finish_reason == null) {
        last.finish_reason = 'stop'
      }
      return null
    }

    if (eventType === 'response.output_item.added') {
      const item = parsed.item || parsed.output_item || parsed
      if (item.type !== 'function_call') return null
      const callId = item.call_id || item.id
      if (!callId) return null
      run.toolCalls.set(callId, responseFunctionCallToToolCall(item))
      return null
    }

    if (eventType === 'response.output_item.done') {
      const item = parsed.item || parsed.output_item || parsed
      if (item.type === 'function_call') {
        const callId = item.call_id || item.id
        if (!callId) return null
        const toolCall = responseFunctionCallToToolCall(item)
        run.toolCalls.set(callId, toolCall)

        const key = `assistant:${callId}`
        if (!run.insertedKeys.has(key)) {
          run.insertedKeys.add(key)
          state.messages.push({
            id: state.messages.length + 1,
            session_id: sessionId,
            runMarker,
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
            finish_reason: 'tool_calls',
            timestamp: now(),
          })
        }
        return {
          event: 'tool.started',
          payload: {
            event: 'tool.started',
            run_id: run.responseId,
            response_id: run.responseId,
            tool_call_id: callId,
            tool: toolCall.function.name,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            preview: summarizeToolArguments(toolCall.function.arguments),
          },
        }
      }

      if (item.type === 'function_call_output') {
        const callId = item.call_id || item.id
        if (!callId) return null
        const key = `tool:${callId}`
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
        const toolName = run.toolCalls.get(callId)?.function?.name || null
        if (!run.insertedKeys.has(key)) {
          run.insertedKeys.add(key)
          state.messages.push({
            id: state.messages.length + 1,
            session_id: sessionId,
            runMarker,
            role: 'tool',
            content: output,
            tool_call_id: callId,
            tool_name: toolName,
            timestamp: now(),
          })
        }
        return {
          event: 'tool.completed',
          payload: {
            event: 'tool.completed',
            run_id: run.responseId,
            response_id: run.responseId,
            tool_call_id: callId,
            tool: toolName,
            name: toolName,
            output,
          },
        }
      }
    }

    if (eventType === 'response.completed') {
      const response = parsed.response || parsed
      run.responseId = response.id || run.responseId
      const output = Array.isArray(response.output) ? response.output : []
      for (const item of output) {
        if (item.type === 'function_call') {
          this.applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
        } else if (item.type === 'function_call_output') {
          this.applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
        }
      }
    }

    return null
  }

  private getResponseRunState(state: SessionState, runMarker?: string): ResponseRunState {
    if (!state.responseRun || state.responseRun.runMarker !== runMarker) {
      state.responseRun = {
        runMarker,
        insertedKeys: new Set<string>(),
        toolCalls: new Map<string, any>(),
      }
    }
    return state.responseRun
  }

  /** Flush all non-user messages for this run to DB in order. */
  private flushResponseRunToDb(state: SessionState, sessionId: string) {
    const run = state.responseRun
    if (!run?.runMarker) return
    let flushed = 0
    for (const msg of state.messages) {
      if (msg.runMarker !== run.runMarker) continue
      if (msg.role === 'user') continue
      addMessage({
        session_id: sessionId,
        role: msg.role,
        content: msg.content || '',
        tool_call_id: msg.tool_call_id ?? null,
        tool_calls: msg.tool_calls ?? null,
        tool_name: msg.tool_name ?? null,
        finish_reason: msg.finish_reason ?? null,
        timestamp: msg.timestamp,
      })
      flushed++
    }
    logger.info('[chat-run-socket] flushResponseRunToDb: flushed %d messages for session %s',
      flushed, sessionId)
  }

  // --- Abort handler ---

  private async handleAbort(socket: Socket, sessionId: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state?.isWorking || (!state.runId && !state.abortController)) {
      logger.info({ sessionId }, '[chat-run-socket][abort] ignored: no active run')
      if (state) {
        state.isWorking = false
        state.isAborting = false
        state.abortController = undefined
        state.runId = undefined
        state.events = []
      }
      this.emitToSession(socket, sessionId, 'abort.completed', {
        event: 'abort.completed',
        synced: false,
        ignored: true,
      })
      return
    }

    const runId = state.runId
    state.isAborting = true
    this.replaceState(sessionId, 'abort.started', {
      event: 'abort.started',
      run_id: runId,
      graceMs: 5000,
    })
    this.emitToSession(socket, sessionId, 'abort.started', {
      event: 'abort.started',
      run_id: runId,
      graceMs: 5000,
    })
    logger.info({ sessionId, runId }, '[chat-run-socket][abort] started')

    // Flush in-memory assistant text to DB before aborting the stream.
    this.flushResponseRunToDb(state, sessionId)

    if (state.abortController) {
      state.abortController.abort()
    }

    await this.markAbortCompleted(socket, sessionId, runId || 'response_stream')
  }

  /** Mark a session run as completed/failed so reconnecting clients get notified */
  private async markCompleted(_socket: Socket, sessionId: string, _info: { event: string; run_id?: string }) {
    const state = this.sessionMap.get(sessionId)
    if (state) {
      if (state.isAborting) {
        logger.info({
          sessionId,
          runId: state.runId,
        }, '[chat-run-socket][abort] terminal upstream event observed; abort handler will finish cleanup')
        return
      }
      state.isWorking = false
      state.abortController = undefined
      state.runId = undefined
      state.events = []
      this.flushResponseRunToDb(state, sessionId)
      state.responseRun = undefined
      state.profile = undefined
      updateSessionStats(sessionId)
      const emit = (event: string, payload: any) => {
        this.nsp.to(`session:${sessionId}`).emit(event, { ...payload, session_id: sessionId })
      }
      await this.calcAndUpdateUsage(sessionId, state, emit)
    }
  }

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
    void this.handleRun(socket, {
      input: next.input,
      session_id: sessionId,
      model: next.model,
      instructions: next.instructions,
    }, next.profile || fallbackProfile, true)
    return true
  }

  private async markAbortCompleted(socket: Socket, sessionId: string, runId: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state) return

    const profile = state.profile
    updateSessionStats(sessionId)

    state.isWorking = false
    state.isAborting = false
    state.profile = undefined
    state.abortController = undefined
    state.runId = undefined
    state.responseRun = undefined

    // Process queued messages after abort completes
    if (state.queue.length > 0) {
      const next = state.queue.shift()!
      logger.info('[chat-run-socket][abort] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
      this.replaceState(sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: runId,
        synced: true,
        queue_length: state.queue.length + 1,
      })
      this.emitToSession(socket, sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: runId,
        synced: true,
        queue_length: state.queue.length + 1,
      })
      this.emitToSession(socket, sessionId, 'run.queued', {
        event: 'run.queued',
        queue_length: state.queue.length,
      })
      state.events = []
      void this.handleRun(socket, {
        input: next.input,
        session_id: sessionId,
        model: next.model,
        instructions: next.instructions,
      }, next.profile || profile || 'default', true)
      return
    }

    state.events = []
    this.replaceState(sessionId, 'abort.completed', {
      event: 'abort.completed',
      run_id: runId,
      synced: true,
    })
    this.emitToSession(socket, sessionId, 'abort.completed', {
      event: 'abort.completed',
      run_id: runId,
      synced: true,
    })
    logger.info({ sessionId, runId, synced: true }, '[chat-run-socket][abort] completed')
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
      let outputTokens: number
      if (snapshot && msgs.length) {
        const newMessages = msgs.slice(snapshot.lastMessageIndex + 1)
        inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
          newMessages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = newMessages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      } else {
        inputTokens = msgs.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = msgs
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      }
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

  /** Get or create session state in sessionMap */
  private getOrCreateSession(sessionId: string): SessionState {
    let state = this.sessionMap.get(sessionId)
    if (!state) {
      state = { messages: [], isWorking: false, events: [], queue: [] }
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

async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = parseSseFrame(raw)
        if (frame?.data) yield frame
        boundary = buffer.indexOf('\n\n')
      }
    }

    buffer += decoder.decode()
    const frame = parseSseFrame(buffer)
    if (frame?.data) yield frame
  } finally {
    reader.releaseLock()
  }
}

function parseSseFrame(raw: string): { event?: string; data: string } | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

function responseFunctionCallToToolCall(item: any): any {
  const callId = item.call_id || item.id || ''
  const name = item.name || item.function?.name || ''
  let args = item.arguments ?? item.function?.arguments ?? '{}'
  if (typeof args !== 'string') {
    args = JSON.stringify(args ?? {})
  }
  return {
    id: callId,
    type: 'function',
    function: {
      name,
      arguments: args || '{}',
    },
  }
}

function summarizeToolArguments(args: string): string | undefined {
  if (!args) return undefined
  try {
    const parsed = JSON.parse(args)
    if (!parsed || typeof parsed !== 'object') return args.slice(0, 120)
    const preferredKeys = ['cmd', 'command', 'code', 'query', 'path', 'url', 'prompt']
    for (const key of preferredKeys) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim()) {
        return value.replace(/\s+/g, ' ').slice(0, 160)
      }
    }
    const first = Object.entries(parsed).find(([, value]) => typeof value === 'string' && value.trim())
    if (first) return String(first[1]).replace(/\s+/g, ' ').slice(0, 160)
    return JSON.stringify(parsed).slice(0, 160)
  } catch {
    return args.replace(/\s+/g, ' ').slice(0, 160)
  }
}

function extractResponseText(response: any): string {
  const output = Array.isArray(response?.output) ? response.output : []
  const parts: string[] = []
  for (const item of output) {
    if (item.type !== 'message') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (part.type === 'output_text' || part.type === 'text') {
        parts.push(part.text || '')
      }
    }
  }
  if (parts.length > 0) return parts.join('')
  return typeof response?.output_text === 'string' ? response.output_text : ''
}
