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
  tool?: string
  name?: string
  preview?: string
  timestamp?: number
  error?: string
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
      }
    },
  } as unknown as AbortController
}

export async function fetchModels(): Promise<{ data: Array<{ id: string }> }> {
  return request('/api/hermes/v1/models')
}
