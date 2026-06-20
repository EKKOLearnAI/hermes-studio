import type { CanonicalResponsesEvent } from './adapters/responses-stream'

export interface CodingAgentMappedEvent {
  event: string
  payload: Record<string, unknown>
}

function responseIdFrom(data: any): string | undefined {
  return data?.response?.id || data?.id || data?.item_id || undefined
}

function reasoningText(data: any): string {
  if (typeof data?.delta === 'string') return data.delta
  if (typeof data?.text === 'string') return data.text
  if (typeof data?.summary === 'string') return data.summary
  if (typeof data?.reasoning === 'string') return data.reasoning
  return ''
}

export function mapCodingAgentResponseEvent(event: CanonicalResponsesEvent): CodingAgentMappedEvent[] {
  const data: any = event.data || {}
  const runId = responseIdFrom(data)
  const mapped: CodingAgentMappedEvent[] = []

  if (
    event.type === 'response.reasoning_text.delta' ||
    event.type === 'response.reasoning.delta' ||
    event.type === 'response.reasoning_summary_text.delta'
  ) {
    const text = reasoningText(data)
    if (text) {
      mapped.push({
        event: 'reasoning.delta',
        payload: {
          event: 'reasoning.delta',
          run_id: runId,
          response_id: runId,
          delta: text,
        },
      })
    }
  }

  return mapped
}
