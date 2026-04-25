import { request, getBaseUrlValue, getApiKey } from '../client'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface StartRunRequest {
  input: string | ChatMessage[]
  instructions?: string
  conversation_history?: ChatMessage[]
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
  return request<StartRunResponse>('/api/hermes/v1/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function streamRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void,
) {
  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  const profile = localStorage.getItem('hermes_active_profile_name')
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (profile && profile !== 'default') params.set('profile', profile)
  const qs = params.toString()
  const url = `${baseUrl}/api/hermes/v1/runs/${runId}/events${qs ? `?${qs}` : ''}`

  let closed = false
  const source = new EventSource(url)

  source.onmessage = (e) => {
    if (closed) return
    try {
      const parsed = JSON.parse(e.data)
      onEvent(parsed)

      if (parsed.event === 'run.completed' || parsed.event === 'run.failed') {
        closed = true
        source.close()
        onDone()
      }
    } catch {
      onEvent({ event: 'message', delta: e.data })
    }
  }

  source.onerror = () => {
    if (closed) return
    closed = true
    source.close()
    onError(new Error('SSE connection error'))
  }

  // Return AbortController-compatible object
  return {
    abort: () => {
      if (!closed) {
        closed = true
        source.close()
        // Trigger onError so the store can clean up stream state and flush
        // any pending busy-input message. Use a distinct error so the store
        // can skip server-resync (the run is being interrupted intentionally).
        onError(new Error('aborted'))
      }
    },
  } as unknown as AbortController
}

export async function fetchModels(): Promise<{ data: Array<{ id: string }> }> {
  return request('/api/hermes/v1/models')
}
