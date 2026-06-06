const DEFAULT_MAX_TTS_CHARS = 1500

const HIDDEN_REASONING_BLOCK_RE = /<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi
const UNCLOSED_HIDDEN_REASONING_BLOCK_RE = /<(think|thinking)\b[^>]*>[\s\S]*/gi
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g
const UNCLOSED_FENCED_CODE_BLOCK_RE = /```[\s\S]*/g
const INLINE_CODE_RE = /`[^`\n]+`/g
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const HTML_DECLARATION_RE = /<![^>]*>/g
const HTML_TAG_RE = /<\/?[a-zA-Z][\w:-]*(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*\/?>/g

export function cleanTtsText(content: string): string {
  if (!content) return ''
  return content
    .replace(HIDDEN_REASONING_BLOCK_RE, ' ')
    .replace(UNCLOSED_HIDDEN_REASONING_BLOCK_RE, ' ')
    .replace(FENCED_CODE_BLOCK_RE, ' ')
    .replace(UNCLOSED_FENCED_CODE_BLOCK_RE, ' ')
    .replace(INLINE_CODE_RE, ' ')
    .replace(HTML_COMMENT_RE, ' ')
    .replace(HTML_DECLARATION_RE, ' ')
    .replace(HTML_TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clampTtsText(text: string, maxChars = DEFAULT_MAX_TTS_CHARS): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 3) return '.'.repeat(Math.max(0, maxChars))
  return `${text.slice(0, maxChars - 3)}...`
}
