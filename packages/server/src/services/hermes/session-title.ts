export interface SessionTitleMessage {
  role?: string | null
  content?: string | null
}

const TITLE_MAX_LENGTH = 72
const TRIVIAL_USER_MESSAGES = new Set([
  'hi',
  'hello',
  'hey',
  'yo',
  'ok',
  'okay',
  'thanks',
  'thank you',
  'test',
  'ping',
])

function containsCjk(text: string): boolean {
  return /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/.test(text)
}

function normalizeLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>+\s*)/, '')
    .replace(/^\s*(?:user|assistant|system)\s*:\s*/i, '')
    .trim()
}

function normalizeTitleSource(value: unknown): string {
  if (typeof value !== 'string') return ''

  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(normalizeLine)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'`“”‘’([\{\s]+/, '')
    .replace(/["'`“”‘’)]?[\]}\s]+$/, '')
    .trim()
}

function finalizeTitle(text: string): string {
  const cleaned = text.replace(/[\s,.;:!?。，、；：]+$/g, '').trim()
  if (cleaned.length <= TITLE_MAX_LENGTH) return cleaned

  const slice = cleaned.slice(0, TITLE_MAX_LENGTH - 3)
  const boundary = slice.lastIndexOf(' ')
  const shortened = boundary >= 24 ? slice.slice(0, boundary) : slice
  return `${shortened.trim()}...`
}

function isUsefulUserMessage(text: string): boolean {
  if (!text) return false
  if (text.startsWith('/')) return false

  const normalized = text
    .toLowerCase()
    .replace(/["'`“”‘’.,!?。，、:;()[\]{}]/g, '')
    .trim()

  if (!normalized) return false
  if (TRIVIAL_USER_MESSAGES.has(normalized)) return false
  if (containsCjk(text)) return text.length >= 4

  const words = normalized.split(/\s+/).filter(Boolean)
  return text.length >= 12 || words.length >= 3
}

function findTitle(messages: SessionTitleMessage[], role: 'user' | 'assistant', predicate?: (text: string) => boolean): string | null {
  for (const message of messages) {
    if (message.role !== role) continue
    const normalized = normalizeTitleSource(message.content)
    if (!normalized) continue
    if (predicate && !predicate(normalized)) continue
    return finalizeTitle(normalized)
  }
  return null
}

export function generateHeuristicSessionTitle(messages: SessionTitleMessage[], fallbackTitle?: string | null): string {
  return (
    findTitle(messages, 'user', isUsefulUserMessage)
    || findTitle(messages, 'assistant')
    || finalizeTitle(normalizeTitleSource(fallbackTitle))
    || 'Untitled session'
  )
}
