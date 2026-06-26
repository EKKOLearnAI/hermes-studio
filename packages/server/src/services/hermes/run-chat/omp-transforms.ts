/**
 * Pure transforms mapping omp (`omp --mode rpc`) wire shapes to the plain
 * strings and token counts hermes-studio persists and streams. omp frames are
 * untrusted subprocess JSON, so every field is narrowed before use. No side
 * effects — unit tested in isolation.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Concatenated text of every `text` content block in an omp assistant message. */
export function ompAssistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  let text = ''
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/** Concatenated reasoning of every `thinking` content block in an omp assistant message. */
export function ompAssistantReasoning(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  let reasoning = ''
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking
  }
  return reasoning
}

/** Flattened text of an omp tool result (`{ content: [{ type:'text', text }] }` or a raw string). */
export function ompToolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!isRecord(result)) return ''
  if (typeof result.text === 'string') return result.text
  if (!Array.isArray(result.content)) return ''
  let text = ''
  for (const item of result.content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') text += item.text
  }
  return text
}

/**
 * Absolute image file paths an omp tool result exposes for display. Image tools
 * such as `generate_image` write the bytes to disk and list the files in
 * `details.imagePaths`; hermes renders each as a markdown image served through
 * the download endpoint (omp runs in the same container, so the paths resolve).
 */
export function ompToolResultImagePaths(result: unknown): string[] {
  if (!isRecord(result) || !isRecord(result.details)) return []
  const paths = result.details.imagePaths
  if (!Array.isArray(paths)) return []
  return paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

export interface OmpRunTokens {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** Normalize an omp `Usage` object into the token counts hermes tracks. */
export function ompUsageTokens(usage: unknown): OmpRunTokens {
  if (!isRecord(usage)) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const input = typeof usage.input === 'number' ? usage.input : 0
  const output = typeof usage.output === 'number' ? usage.output : 0
  const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0
  const cacheWrite = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0
  const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : input + output + cacheRead + cacheWrite
  return { inputTokens: input, outputTokens: output, totalTokens: total }
}
