import type { SessionMessage } from './types'

export const RESUME_TOOL_RESULT_DISPLAY_LIMIT = 1_000

const JSON_STRING_DISPLAY_LIMIT = 200
const JSON_MAX_DEPTH = 6
const JSON_MAX_NODES = 1_000
const JSON_MAX_KEYS_PER_OBJECT = 50
const JSON_MAX_ITEMS_PER_ARRAY = 50
const JSON_TRUNCATED_KEY = '__truncated__'
const TRUNCATED_MARKER = '... (truncated)'

type ResumeMessage = SessionMessage & Record<string, unknown>
type RunEventRecord = { event: string; data: any }

function stringifyLength(value: unknown): number {
  try {
    return JSON.stringify(value, null, 2)?.length || 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function truncateJsonValue(value: unknown): unknown {
  let nodeCount = 0
  const seen = new WeakSet<object>()

  function visit(current: unknown, depth: number): unknown {
    nodeCount += 1
    if (nodeCount > JSON_MAX_NODES) return TRUNCATED_MARKER
    if (typeof current === 'string') {
      return current.length > JSON_STRING_DISPLAY_LIMIT
        ? `${current.slice(0, JSON_STRING_DISPLAY_LIMIT)}\n${TRUNCATED_MARKER}`
        : current
    }
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) return `[Circular ${TRUNCATED_MARKER}]`
    if (depth >= JSON_MAX_DEPTH) {
      return Array.isArray(current)
        ? `[Array ${TRUNCATED_MARKER}]`
        : `[Object ${TRUNCATED_MARKER}]`
    }

    seen.add(current)
    if (Array.isArray(current)) {
      const result: unknown[] = []
      const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY)
      for (let index = 0; index < maxItems; index += 1) {
        const remaining = current.length - index
        result.push(visit(current[index], depth + 1))
        if (stringifyLength(result) > RESUME_TOOL_RESULT_DISPLAY_LIMIT) {
          result.pop()
          result.push(`${TRUNCATED_MARKER}: ${remaining} more items`)
          seen.delete(current)
          return result
        }
      }
      if (current.length > maxItems) {
        result.push(`${TRUNCATED_MARKER}: ${current.length - maxItems} more items`)
      }
      seen.delete(current)
      return result
    }

    const entries = Object.entries(current as Record<string, unknown>)
    const result: Record<string, unknown> = {}
    const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT)
    for (let index = 0; index < maxKeys; index += 1) {
      const [key, entryValue] = entries[index]
      const remaining = entries.length - index
      result[key] = visit(entryValue, depth + 1)
      if (stringifyLength(result) > RESUME_TOOL_RESULT_DISPLAY_LIMIT) {
        delete result[key]
        result[JSON_TRUNCATED_KEY] = `${TRUNCATED_MARKER}: ${remaining} more keys`
        seen.delete(current)
        return result
      }
    }
    if (entries.length > maxKeys) {
      result[JSON_TRUNCATED_KEY] = `${TRUNCATED_MARKER}: ${entries.length - maxKeys} more keys`
    }
    seen.delete(current)
    return result
  }

  const truncated = visit(value, 0)
  return stringifyLength(truncated) <= RESUME_TOOL_RESULT_DISPLAY_LIMIT
    ? truncated
    : { [JSON_TRUNCATED_KEY]: TRUNCATED_MARKER }
}

function looksLikeUnifiedDiff(content: string): boolean {
  const lines = content.trimStart().split('\n', 12)
  const hasFileHeader = lines.some(line => line.startsWith('diff --git ') || line.startsWith('--- '))
  const hasTargetHeader = lines.some(line => line.startsWith('+++ '))
  const hasHunk = lines.some(line => line.startsWith('@@ '))
  return hasFileHeader && (hasTargetHeader || hasHunk)
}

function truncateToolResult(content: string): string {
  if (content.length <= RESUME_TOOL_RESULT_DISPLAY_LIMIT || looksLikeUnifiedDiff(content)) return content

  if (/^[\[{]/.test(content.trim())) {
    try {
      return JSON.stringify(truncateJsonValue(JSON.parse(content)), null, 2)
    } catch {
      // Preserve the existing plain-text rendering for incomplete JSON output.
    }
  }

  const suffix = `\n${TRUNCATED_MARKER}`
  const previewLength = RESUME_TOOL_RESULT_DISPLAY_LIMIT - suffix.length
  return `${content.slice(0, previewLength)}${suffix}`
}

function truncateMessageField(
  target: ResumeMessage,
  field: 'content' | 'display_content',
): boolean {
  const content = target[field]
  if (typeof content !== 'string' || content.length <= RESUME_TOOL_RESULT_DISPLAY_LIMIT) return false
  const truncated = truncateToolResult(content)
  if (truncated === content) return false
  target[field] = truncated
  target[`${field}_truncated`] = true
  target[`${field}_original_length`] = content.length
  return true
}

/**
 * Build the display-only message page emitted by `resume`.
 *
 * The session state and persisted history intentionally retain complete tool
 * results. Only cloned outbound tool rows are bounded to the same 1000-character
 * display threshold previously enforced by the Studio client.
 */
export function buildResumeMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.map((message) => {
    const isToolResult = message.role === 'tool'
      || message.role === 'moa'
      || message.display_role === 'tool'
    if (!isToolResult) return message

    const outbound = { ...message } as ResumeMessage
    const contentTruncated = truncateMessageField(outbound, 'content')
    const displayContentTruncated = truncateMessageField(outbound, 'display_content')
    return contentTruncated || displayContentTruncated ? outbound : message
  })
}

/**
 * Bound a live tool result only at the WebSocket delivery boundary. Callers
 * keep using the original payload for persistence, webhooks and state.
 */
export function buildOutboundRunEvent(event: string, payload: any): any {
  if (event !== 'tool.completed' && event !== 'tool.failed') return payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload

  const outbound = { ...payload }
  let changed = false
  if (typeof outbound.output === 'string' && outbound.output.length > RESUME_TOOL_RESULT_DISPLAY_LIMIT) {
    const output = truncateToolResult(outbound.output)
    if (output !== outbound.output) {
      outbound.output = output
      outbound.output_truncated = true
      outbound.output_original_length = payload.output.length
      changed = true
    }
  }

  if (typeof outbound.preview === 'string') {
    const singleLinePreview = outbound.preview.replace(/\s+/g, ' ').trim()
    const preview = singleLinePreview.length > 100
      ? `${singleLinePreview.slice(0, 97)}...`
      : singleLinePreview
    if (preview !== outbound.preview) {
      outbound.preview = preview
      if (singleLinePreview.length > 100) {
        outbound.preview_truncated = true
        outbound.preview_original_length = payload.preview.length
      }
      changed = true
    }
  }
  return changed ? outbound : payload
}

export function buildResumeEvents(events: RunEventRecord[]): RunEventRecord[] {
  return events.map((entry) => {
    const data = buildOutboundRunEvent(entry.event, entry.data)
    return data === entry.data ? entry : { ...entry, data }
  })
}
