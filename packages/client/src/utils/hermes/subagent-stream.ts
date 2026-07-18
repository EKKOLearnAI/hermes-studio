export const OPEN_SUBAGENT_STREAM_EVENT = 'hermes:open-subagent-stream'

export interface OpenSubagentStreamDetail {
  sessionId: string
  subagentId: string
}

export function subagentIdFromToolCall(toolCallId?: string): string | null {
  const prefix = 'subagent:'
  if (!toolCallId?.startsWith(prefix)) return null
  const subagentId = toolCallId.slice(prefix.length).trim()
  return subagentId || null
}

export function openSubagentStream(sessionId: string | null | undefined, toolCallId?: string): boolean {
  const subagentId = subagentIdFromToolCall(toolCallId)
  if (!sessionId || !subagentId || typeof window === 'undefined') return false
  window.dispatchEvent(new CustomEvent<OpenSubagentStreamDetail>(OPEN_SUBAGENT_STREAM_EVENT, {
    detail: { sessionId, subagentId },
  }))
  return true
}
