export const TOOL_RESULT_CONTEXT_LIMIT = 5_500
export const TOOL_RESULT_CONTEXT_HEAD_CHARS = 4_000
export const TOOL_RESULT_CONTEXT_MARKER = '\n... [truncated]\n...'
export const TOOL_RESULT_CONTEXT_TAIL_CHARS =
  TOOL_RESULT_CONTEXT_LIMIT - TOOL_RESULT_CONTEXT_HEAD_CHARS - TOOL_RESULT_CONTEXT_MARKER.length

/**
 * Bound tool results when they are projected into model context.
 *
 * Persistence intentionally keeps the complete result. This projection mirrors
 * the long-standing context-compressor rule: preserve the useful beginning and
 * ending while preventing one tool response from dominating the context.
 */
export function truncateToolResultForContext(content: string): string {
  if (content.length <= TOOL_RESULT_CONTEXT_LIMIT) return content
  return content.slice(0, TOOL_RESULT_CONTEXT_HEAD_CHARS) +
    TOOL_RESULT_CONTEXT_MARKER +
    content.slice(-TOOL_RESULT_CONTEXT_TAIL_CHARS)
}
