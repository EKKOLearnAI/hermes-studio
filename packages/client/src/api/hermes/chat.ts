import { io, type Socket } from 'socket.io-client'
import { getBaseUrlValue, getApiKey } from '../client'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string }
  | { type: 'file'; name: string; path: string; media_type?: string }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}

export interface StartRunRequest {
  input: string | ContentBlock[]
  instructions?: string
  session_id?: string
  profile?: string
  model?: string
  provider?: string
  model_groups?: Array<{ provider: string; models: string[] }>
  queue_id?: string
  source?: 'api_server' | 'cli'
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
  /** Queue length from run.queued event */
  queue_length?: number
  /** Queue item that was just removed because it is starting now. */
  dequeued_queue_id?: string
  /** Queued user messages from run.queued/resume payloads. */
  queued_messages?: Array<{
    id?: string | number
    role?: string
    content?: string
    timestamp?: number
    queued?: boolean
  }>
  /** User message broadcast to other windows already watching the same session. */
  message?: {
    id?: string | number
    role?: string
    content?: string
    timestamp?: number
    queued?: boolean
  }
}

export interface ResumeSessionPayload {
  session_id: string
  messages: any[]
  isWorking: boolean
  isAborting?: boolean
  events: Array<{ event: string; data: RunEvent }>
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  queueLength?: number
  queueMessages?: RunEvent['queued_messages']
}

// ============================
// Socket.IO chat run connection
// ============================

let chatRunSocket: Socket | null = null
let globalListenersRegistered = false
let chatRunSocketProfile: string | null = null

const TRANSIENT_DISCONNECT_REASONS = new Set<string>([
  'transport close',
  'transport error',
  'ping timeout',
])

/**
 * Session event handlers map
 * Maps session_id to event handling functions for isolating concurrent session streams
 */
const sessionEventHandlers = new Map<string, {
  onMessageDelta: (event: RunEvent) => void
  onReasoningDelta: (event: RunEvent) => void
  onThinkingDelta: (event: RunEvent) => void
  onReasoningAvailable: (event: RunEvent) => void
  onToolStarted: (event: RunEvent) => void
  onToolCompleted: (event: RunEvent) => void
  onSubagentEvent?: (event: RunEvent) => void
  onRunStarted: (event: RunEvent) => void
  onRunCompleted: (event: RunEvent) => void
  onRunFailed: (event: RunEvent) => void
  onCompressionStarted: (event: RunEvent) => void
  onCompressionCompleted: (event: RunEvent) => void
  onAbortStarted: (event: RunEvent) => void
  onAbortCompleted: (event: RunEvent) => void
  onUsageUpdated: (event: RunEvent) => void
  onSessionCommand?: (event: RunEvent) => void
  onRunQueued?: (event: RunEvent) => void
  onApprovalRequested?: (event: RunEvent) => void
  onApprovalResolved?: (event: RunEvent) => void
  onPeerUserMessage?: (event: RunEvent) => void
  onClarifyRequested?: (event: RunEvent) => void
  onClarifyResolved?: (event: RunEvent) => void
}>()

const peerUserMessageHandlers = new Set<(event: RunEvent) => void>()

/**
 * Global message.delta event handler
 * Distributes events to appropriate session based on session_id
 */
function globalMessageDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onMessageDelta) {
    handlers.onMessageDelta(event)
  }
}

/**
 * Global reasoning.delta event handler
 */
function globalReasoningDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onReasoningDelta) {
    handlers.onReasoningDelta(event)
  }
}

/**
 * Global thinking.delta event handler (alias for reasoning.delta)
 */
function globalThinkingDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onThinkingDelta) {
    handlers.onThinkingDelta(event)
  }
}

/**
 * Global reasoning.available event handler
 */
function globalReasoningAvailableHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onReasoningAvailable) {
    handlers.onReasoningAvailable(event)
  }
}

/**
 * Global tool.started event handler
 */
function globalToolStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onToolStarted) {
    handlers.onToolStarted(event)
  }
}

/**
 * Global tool.completed event handler
 */
function globalToolCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onToolCompleted) {
    handlers.onToolCompleted(event)
  }
}

function globalSubagentEventHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onSubagentEvent) {
    handlers.onSubagentEvent(event)
  }
}

/**
 * Global run.started event handler
 */
function globalRunStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunStarted) {
    handlers.onRunStarted(event)
  }
}

/**
 * Global run.completed event handler
 */
function globalRunCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunCompleted) {
    handlers.onRunCompleted(event)
  }

  // Auto-cleanup session handlers on completion (skip if more runs queued)
  if ((event as any).queue_remaining > 0) return
  sessionEventHandlers.delete(sid)
}

/**
 * Global run.failed event handler
 */
function globalRunFailedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunFailed) {
    handlers.onRunFailed(event)
  }

  // Auto-cleanup session handlers on failure (skip if more runs queued)
  if ((event as any).queue_remaining > 0) return
  sessionEventHandlers.delete(sid)
}

/**
 * Global run.queued event handler
 */
function globalRunQueuedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunQueued) {
    handlers.onRunQueued(event)
  }
}

/**
 * Global compression.started event handler
 */
function globalCompressionStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onCompressionStarted) {
    handlers.onCompressionStarted(event)
  }
}

/**
 * Global compression.completed event handler
 */
function globalCompressionCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onCompressionCompleted) {
    handlers.onCompressionCompleted(event)
  }
}

/**
 * Global abort.started event handler
 */
function globalAbortStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAbortStarted) {
    handlers.onAbortStarted(event)
  }
}

/**
 * Global abort.completed event handler
 */
function globalAbortCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAbortCompleted) {
    handlers.onAbortCompleted(event)
  }

  // If abort completion is followed by queued runs, keep the handler alive so
  // the next run.started/message.delta/run.completed events are still received.
  if ((event as any).queue_length > 0) return
  sessionEventHandlers.delete(sid)
}

/**
 * Global usage.updated event handler
 */
function globalUsageUpdatedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onUsageUpdated) {
    handlers.onUsageUpdated(event)
  }
}

function globalSessionCommandHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onSessionCommand) {
    handlers.onSessionCommand(event)
  }
}

function globalApprovalRequestedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onApprovalRequested) {
    handlers.onApprovalRequested(event)
  }
}

function globalApprovalResolvedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onApprovalResolved) {
    handlers.onApprovalResolved(event)
  }
}

function globalPeerUserMessageHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onPeerUserMessage) {
    handlers.onPeerUserMessage(event)
  }

  for (const handler of peerUserMessageHandlers) {
    handler(event)
  }
}

function globalClarifyRequestedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onClarifyRequested) {
    handlers.onClarifyRequested(event)
  }
}

function globalClarifyResolvedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onClarifyResolved) {
    handlers.onClarifyResolved(event)
  }
}

/**
 * Register event handlers for a session
 * @param sessionId - Session ID
 * @param handlers - Event handling functions
 * @returns Cleanup function to unregister handlers
 */
export function registerSessionHandlers(
  sessionId: string,
  handlers: {
    onMessageDelta: (event: RunEvent) => void
    onReasoningDelta: (event: RunEvent) => void
    onThinkingDelta: (event: RunEvent) => void
    onReasoningAvailable: (event: RunEvent) => void
    onToolStarted: (event: RunEvent) => void
    onToolCompleted: (event: RunEvent) => void
    onSubagentEvent?: (event: RunEvent) => void
    onRunStarted: (event: RunEvent) => void
    onRunCompleted: (event: RunEvent) => void
    onRunFailed: (event: RunEvent) => void
    onCompressionStarted: (event: RunEvent) => void
    onCompressionCompleted: (event: RunEvent) => void
    onAbortStarted: (event: RunEvent) => void
    onAbortCompleted: (event: RunEvent) => void
    onUsageUpdated: (event: RunEvent) => void
    onSessionCommand?: (event: RunEvent) => void
    onRunQueued?: (event: RunEvent) => void
    onApprovalRequested?: (event: RunEvent) => void
    onApprovalResolved?: (event: RunEvent) => void
    onPeerUserMessage?: (event: RunEvent) => void
    onClarifyRequested?: (event: RunEvent) => void
    onClarifyResolved?: (event: RunEvent) => void
  }
): () => void {
  sessionEventHandlers.set(sessionId, handlers)

  // Return cleanup function
  return () => {
    sessionEventHandlers.delete(sessionId)
  }
}

/**
 * Unregister event handlers for a session
 * @param sessionId - Session ID
 */
export function unregisterSessionHandlers(sessionId: string): void {
  sessionEventHandlers.delete(sessionId)
}

export function onPeerUserMessage(handler: (event: RunEvent) => void): () => void {
  peerUserMessageHandlers.add(handler)
  return () => {
    peerUserMessageHandlers.delete(handler)
  }
}

export function respondClarify(
  sessionId: string,
  clarifyId: string,
  response: string,
): void {
  const socket = connectChatRun()
  socket.emit('clarify.respond', {
    session_id: sessionId,
    clarify_id: clarifyId,
    response,
  })
}

export function respondToolApproval(
  sessionId: string,
  approvalId: string,
  choice: 'once' | 'session' | 'always' | 'deny',
): void {
  const socket = connectChatRun()
  socket.emit('approval.respond', {
    session_id: sessionId,
    approval_id: approvalId,
    choice,
  })
}

export function getChatRunSocket(): Socket | null {
  return chatRunSocket
}

export function connectChatRun(requestedProfile?: string | null): Socket {
  const normalizedRequestedProfile = requestedProfile?.trim() || null
  if (chatRunSocket?.connected && (!normalizedRequestedProfile || chatRunSocketProfile === normalizedRequestedProfile)) {
    return chatRunSocket
  }

  // Clean up old socket to prevent duplicate event listeners
  if (chatRunSocket) {
    chatRunSocket.removeAllListeners()
    chatRunSocket.disconnect()
    globalListenersRegistered = false
    chatRunSocketProfile = null
  }

  const baseUrl = getBaseUrlValue()
  const token = getApiKey()

  // Get active profile from store (authoritative source)
  let profile = normalizedRequestedProfile || 'default'
  try {
    if (!normalizedRequestedProfile) {
      const { useProfilesStore } = require('@/stores/hermes/profiles')
      const profilesStore = useProfilesStore()
      profile = profilesStore.activeProfileName || 'default'
    }
  } catch {
    // Fallback to localStorage during early initialization
    profile = normalizedRequestedProfile || localStorage.getItem('hermes_active_profile_name') || 'default'
  }
  chatRunSocketProfile = profile

  chatRunSocket = io(`${baseUrl}/chat-run`, {
    auth: { token },
    query: { profile },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 30000,
  })

  // Register global listeners only once per socket connection
  if (!globalListenersRegistered) {
    // Message events
    chatRunSocket.on('message.delta', globalMessageDeltaHandler)
    chatRunSocket.on('reasoning.delta', globalReasoningDeltaHandler)
    chatRunSocket.on('thinking.delta', globalThinkingDeltaHandler)
    chatRunSocket.on('reasoning.available', globalReasoningAvailableHandler)

    // Tool events
    chatRunSocket.on('tool.started', globalToolStartedHandler)
    chatRunSocket.on('tool.completed', globalToolCompletedHandler)
    chatRunSocket.on('subagent.start', globalSubagentEventHandler)
    chatRunSocket.on('subagent.tool', globalSubagentEventHandler)
    chatRunSocket.on('subagent.progress', globalSubagentEventHandler)
    chatRunSocket.on('subagent.complete', globalSubagentEventHandler)

    // Run lifecycle events
    chatRunSocket.on('run.started', globalRunStartedHandler)
    chatRunSocket.on('run.failed', globalRunFailedHandler)
    chatRunSocket.on('run.completed', globalRunCompletedHandler)
    chatRunSocket.on('run.queued', globalRunQueuedHandler)
    chatRunSocket.on('approval.requested', globalApprovalRequestedHandler)
    chatRunSocket.on('approval.resolved', globalApprovalResolvedHandler)
    chatRunSocket.on('run.peer_user_message', globalPeerUserMessageHandler)
    chatRunSocket.on('clarify.requested', globalClarifyRequestedHandler)
    chatRunSocket.on('clarify.resolved', globalClarifyResolvedHandler)

    // Compression events
    chatRunSocket.on('compression.started', globalCompressionStartedHandler)
    chatRunSocket.on('compression.completed', globalCompressionCompletedHandler)
    chatRunSocket.on('abort.started', globalAbortStartedHandler)
    chatRunSocket.on('abort.completed', globalAbortCompletedHandler)

    // Usage events
    chatRunSocket.on('usage.updated', globalUsageUpdatedHandler)
    chatRunSocket.on('session.command', globalSessionCommandHandler)

    globalListenersRegistered = true
  }

  return chatRunSocket
}

export function disconnectChatRun(): void {
  if (chatRunSocket) {
    chatRunSocket.disconnect()
    chatRunSocket = null
    chatRunSocketProfile = null
    globalListenersRegistered = false
    sessionEventHandlers.clear()
  }
}

function removeSocketListener(socket: Socket, event: string, handler: (...args: any[]) => void): void {
  const candidate = socket as Socket & {
    off?: (event: string, handler: (...args: any[]) => void) => Socket
    removeListener?: (event: string, handler: (...args: any[]) => void) => Socket
  }
  if (typeof candidate.off === 'function') {
    candidate.off(event, handler)
    return
  }
  candidate.removeListener?.(event, handler)
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
  onResumed: (data: ResumeSessionPayload) => void,
  profile?: string | null,
): Socket {
  const socket = connectChatRun(profile)

  socket.once('resumed', onResumed)
  socket.emit('resume', { session_id: sessionId, ...(profile ? { profile } : {}) })

  return socket
}

export function startRunViaSocket(
  body: StartRunRequest,
  onEvent: (event: RunEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStarted?: (runId: string) => void,
  options?: {
    onReconnectResume?: (data: ResumeSessionPayload) => void
  },
): { abort: () => void } {
  const sid = body.session_id
  if (!sid) {
    throw new Error('session_id is required for startRunViaSocket')
  }

  let closed = false
  const socket = connectChatRun(body.profile)
  if (sessionEventHandlers.has(sid)) {
    socket.emit('run', body)
    return {
      abort: () => {
        if (!closed) {
          socket.emit('abort', { session_id: sid })
        }
      },
    }
  }

  let sawTransientDisconnect = false
  let removeTerminalSocketListeners: () => void = () => {}
  let reconnectResumeHandler: ((data: ResumeSessionPayload) => void) | null = null

  const clearReconnectResumeHandler = () => {
    if (!reconnectResumeHandler) return
    removeSocketListener(socket, 'resumed', reconnectResumeHandler)
    reconnectResumeHandler = null
  }

  const emitReconnectResume = () => {
    clearReconnectResumeHandler()
    if (options?.onReconnectResume) {
      reconnectResumeHandler = (data: ResumeSessionPayload) => {
        clearReconnectResumeHandler()
        if (closed || data.session_id !== sid) return
        options.onReconnectResume?.(data)
      }
      socket.on('resumed', reconnectResumeHandler)
    }
    socket.emit('resume', { session_id: sid, ...(body.profile ? { profile: body.profile } : {}) })
  }

  const handleSocketError = (err: Error) => {
    if (closed) return
    closed = true
    removeTerminalSocketListeners()
    sessionEventHandlers.delete(sid)
    onError(err)
  }
  const handleSocketConnectError = (err: Error) => {
    if (closed) return
    if (sawTransientDisconnect) return
    handleSocketError(err)
  }
  socket.on('connect_error', handleSocketConnectError)
  const handleSocketDisconnect = (reason: string) => {
    if (closed || reason === 'io client disconnect') return
    if (TRANSIENT_DISCONNECT_REASONS.has(reason)) {
      sawTransientDisconnect = true
      return
    }
    handleSocketError(new Error(`Socket disconnected: ${reason}`))
  }
  socket.on('disconnect', handleSocketDisconnect)

  const handleSocketReconnect = () => {
    if (closed || !sawTransientDisconnect) return
    sawTransientDisconnect = false
    emitReconnectResume()
  }
  socket.on('connect', handleSocketReconnect)

  removeTerminalSocketListeners = () => {
    clearReconnectResumeHandler()
    removeSocketListener(socket, 'connect_error', handleSocketConnectError)
    removeSocketListener(socket, 'disconnect', handleSocketDisconnect)
    removeSocketListener(socket, 'connect', handleSocketReconnect)
  }

  // Define event handlers for this session
  const handlers = {
    onMessageDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onReasoningDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onThinkingDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onReasoningAvailable: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onToolStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onToolCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onSubagentEvent: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onRunStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      onStarted?.(evt.run_id || '')
    },
    onRunCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_remaining > 0) return
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onRunFailed: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_remaining > 0) return
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onCompressionStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onCompressionCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAbortStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAbortCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_length > 0) return
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onUsageUpdated: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onSessionCommand: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).terminal === false) return
      closed = true
      removeTerminalSocketListeners()
      sessionEventHandlers.delete(sid)
      onDone()
    },
    onRunQueued: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onApprovalRequested: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onApprovalResolved: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onClarifyRequested: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onClarifyResolved: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
  }

  // Register handlers in the global session map
  sessionEventHandlers.set(sid, handlers)

  // Emit run request
  socket.emit('run', body)

  return {
    abort: () => {
      if (!closed) {
        socket.emit('abort', { session_id: sid })
      }
    },
  }
}
