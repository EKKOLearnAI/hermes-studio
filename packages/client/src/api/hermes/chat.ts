import { request } from '../client'

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
}

export async function startRun(body: StartRunRequest): Promise<StartRunResponse> {
  const headers: Record<string, string> = {}
  if (body.session_id) {
    headers['X-Hermes-Session-Id'] = body.session_id
  }
  return request<StartRunResponse>('/api/hermes/v1/runs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  })
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

export interface ApproveRunRequest {
  choice?: 'once' | 'session' | 'always'
  resolve_all?: boolean
}

export interface ApproveRunResponse {
  approved: number
  choice: string
}

export async function approveRun(runId: string, body: ApproveRunRequest = {}): Promise<ApproveRunResponse> {
  return request<ApproveRunResponse>(`/api/hermes/v1/runs/${runId}/approve`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export interface DenyRunRequest {
  resolve_all?: boolean
}

export interface DenyRunResponse {
  denied: number
}

export async function denyRun(runId: string, body: DenyRunRequest = {}): Promise<DenyRunResponse> {
  return request<DenyRunResponse>(`/api/hermes/v1/runs/${runId}/deny`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
