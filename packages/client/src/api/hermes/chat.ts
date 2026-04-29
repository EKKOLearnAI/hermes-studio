import { io, type Socket } from 'socket.io-client'
import { request, getBaseUrlValue, getApiKey } from '../client'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface StartRunRequest {
  input: string | ChatMessage[]
  instructions?: string
  session_id?: string
  model?: string
}

export interface StartRunResponse {
  run_id: string
  status: string
}

// SSE event types from /v1/runs/{id}/events
export interface RunEvent {
  event: string
  run_id?: string
  delta?: string
  /** Payload text for `reasoning.delta` / `thinking.delta` / `reasoning.available` events. */
  text?: string
  tool?: string
  name?: string
  preview?: string
  timestamp?: number
  error?: string
  /** Final response text on `run.completed`. May be empty/null if the agent
   * silently swallowed an upstream error — see chat store for fallback. */
  output?: string | null
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  /** session_id tag added by server for client-side filtering */
  session_id?: string
}

// ============================
// Socket.IO chat run connection
// ============================

let chatRunSocket: Socket | null = null

export function getChatRunSocket(): Socket | null {
  return chatRunSocket
}

export function connectChatRun(): Socket {
  if (chatRunSocket?.connected) return chatRunSocket

  // Clean up old socket to prevent duplicate event listeners
  if (chatRunSocket) {
    chatRunSocket.removeAllListeners()
    chatRunSocket.disconnect()
  }

  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  const profile = localStorage.getItem('hermes_active_profile_name') || 'default'

  chatRunSocket = io(`${baseUrl}/chat-run`, {
    auth: { token },
    query: { profile },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  })

  return chatRunSocket
}

export function disconnectChatRun(): void {
  if (chatRunSocket) {
    chatRunSocket.disconnect()
    chatRunSocket = null
  }
}

/**
 * Start a chat run via Socket.IO and stream events back.
 * Returns an AbortController-compatible handle for cancellation.
 */
/**
 * Resume a session via Socket.IO. Returns messages, working status, and events.
 */
export function resumeSession(
  sessionId: string,
  onResumed: (data: { session_id: string; messages: any[]; isWorking: boolean; events: any[]; inputTokens?: number; outputTokens?: number }) => void,
): Socket {
  const socket = connectChatRun()

  socket.once('resumed', onResumed)
  socket.emit('resume', { session_id: sessionId })

  return socket
}

export function startRunViaSocket(
  body: StartRunRequest,
  onEvent: (event: RunEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStarted?: (runId: string) => void,
): { abort: () => void } {
  const socket = connectChatRun()
  let closed = false

  function cleanup() {
    if (closed) return
    closed = true
    socket.off('run.started', onRunStarted)
    socket.off('run.failed', onRunFailed)
    socket.off('message.delta', onMessageDelta)
    socket.off('reasoning.delta', onReasoningDelta)
    socket.off('thinking.delta', onReasoningDelta)
    socket.off('reasoning.available', onReasoningAvailable)
    socket.off('tool.started', onToolStarted)
    socket.off('tool.completed', onToolCompleted)
    socket.off('run.completed', onRunCompleted)
    socket.off('compression.started', onCompressionStarted)
    socket.off('compression.completed', onCompressionCompleted)
    socket.off('usage.updated', onUsageUpdated)
  }

  // All event handlers share the same cleanup logic
  const handleEvent = (event: RunEvent) => {
    if (closed) return
    onEvent(event)
    if (event.event === 'run.completed' || event.event === 'run.failed') {
      cleanup()
      onDone()
    }
  }

  function onRunStarted(data: RunEvent) {
    handleEvent(data)
    onStarted?.(data.run_id || '')
  }
  function onRunFailed(data: RunEvent) {
    handleEvent(data)
    onError?.(new Error(data.error || 'Run failed'))
  }
  function onMessageDelta(data: RunEvent) { handleEvent(data) }
  function onReasoningDelta(data: RunEvent) { handleEvent(data) }
  function onThinkingDelta(data: RunEvent) { handleEvent(data) }
  function onReasoningAvailable(data: RunEvent) { handleEvent(data) }
  function onToolStarted(data: RunEvent) { handleEvent(data) }
  function onToolCompleted(data: RunEvent) { handleEvent(data) }
  function onRunCompleted(data: RunEvent) { handleEvent(data) }
  function onCompressionStarted(data: RunEvent) { handleEvent(data) }
  function onCompressionCompleted(data: RunEvent) { handleEvent(data) }
  function onUsageUpdated(data: RunEvent) { handleEvent(data) }

  socket.on('run.started', onRunStarted)
  socket.on('run.failed', onRunFailed)
  socket.on('message.delta', onMessageDelta)
  socket.on('reasoning.delta', onReasoningDelta)
  socket.on('thinking.delta', onThinkingDelta)
  socket.on('reasoning.available', onReasoningAvailable)
  socket.on('tool.started', onToolStarted)
  socket.on('tool.completed', onToolCompleted)
  socket.on('run.completed', onRunCompleted)
  socket.on('compression.started', onCompressionStarted)
  socket.on('compression.completed', onCompressionCompleted)
  socket.on('usage.updated', onUsageUpdated)

  // Emit run:start with ack callback to get run_id
  socket.emit('run', body)

  return {
    abort: () => {
      if (!closed) {
        socket.emit('abort', { session_id: body.session_id })
        cleanup()
      }
    },
  }
}

export async function fetchModels(): Promise<{ data: Array<{ id: string }> }> {
  return request('/api/hermes/v1/models')
}
