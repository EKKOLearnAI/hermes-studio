import { config } from '../../config'
import { logger } from '../logger'

const UPSTREAM = config.upstream.replace(/\/$/, '')

/**
 * Send an instruction to Hermes Agent via /v1/runs
 */
export async function sendInstruction(params: {
  input: string | any[]
  instructions?: string
  conversationHistory?: any[]
  sessionId?: string
  authToken?: string
}): Promise<{ run_id: string; status: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (params.authToken) {
    headers['Authorization'] = `Bearer ${params.authToken}`
  }

  const body: any = { input: params.input }
  if (params.instructions) body.instructions = params.instructions
  if (params.conversationHistory) body.conversation_history = params.conversationHistory
  if (params.sessionId) body.session_id = params.sessionId

  const res = await fetch(`${UPSTREAM}/v1/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Hermes API error ${res.status}: ${text}`)
  }

  return res.json()
}

/**
 * Get run status (poll /v1/runs/:id if supported)
 */
export async function getRunStatus(runId: string): Promise<any> {
  const res = await fetch(`${UPSTREAM}/v1/runs/${runId}`)
  if (!res.ok) {
    throw new Error(`Failed to get run status: ${res.status}`)
  }
  return res.json()
}

/**
 * Subscribe to SSE events for a run
 */
export async function* streamRunEvents(runId: string, authToken?: string): AsyncGenerator<any> {
  const headers: Record<string, string> = {}
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  const res = await fetch(`${UPSTREAM}/v1/runs/${runId}/events`, { headers })
  if (!res.ok || !res.body) {
    throw new Error(`Failed to stream run events: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') return
          try {
            const event = JSON.parse(data)
            yield event
            if (event.event === 'run.completed' || event.event === 'run.failed') return
          } catch { /* skip malformed lines */ }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Health check
 */
export async function healthCheck(): Promise<{ status: string; version?: string }> {
  const res = await fetch(`${UPSTREAM}/health`)
  return res.json()
}

/**
 * Fetch available models
 */
export async function fetchModels(): Promise<{ data: Array<{ id: string }> }> {
  const res = await fetch(`${UPSTREAM}/v1/models`)
  return res.json()
}

// Webhook callback registry
type WebhookCallback = (payload: any) => void | Promise<void>
const webhookCallbacks: WebhookCallback[] = []

export function onWebhook(callback: WebhookCallback) {
  webhookCallbacks.push(callback)
}

export function emitWebhook(payload: any) {
  for (const cb of webhookCallbacks) {
    const result = cb(payload)
    if (result && typeof result.catch === 'function') {
      result.catch((err: Error) => logger.error(err, 'Webhook callback error'))
    }
  }
}
