const DEFAULT_MAX_TTS_CHARS = 1500

export function cleanTtsText(content: string): string {
  if (!content) return ''
  return content
    .replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thinking[^>]*>[\s\S]*/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clampTtsText(text: string, maxChars = DEFAULT_MAX_TTS_CHARS): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 3) return '.'.repeat(Math.max(0, maxChars))
  return `${text.slice(0, maxChars - 3)}...`
}
