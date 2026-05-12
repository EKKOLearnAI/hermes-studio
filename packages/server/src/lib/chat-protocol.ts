export interface SanitizedChatText {
  text: string
  stripped: boolean
}

const CODE_FENCE_PATTERN = /```[\s\S]*?```/g

export function normalizeToolName(name: string | null | undefined): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return 'tool'
  return trimmed.startsWith('functions.') ? trimmed.slice('functions.'.length) : trimmed
}

export function sanitizeAssistantText(input: string): SanitizedChatText {
  if (!input) return { text: '', stripped: false }

  let stripped = false
  let text = ''
  let lastIndex = 0

  for (const match of input.matchAll(CODE_FENCE_PATTERN)) {
    const start = match.index ?? 0
    text += sanitizePlainSegment(input.slice(lastIndex, start), strippedState => {
      stripped = stripped || strippedState
    })
    text += match[0]
    lastIndex = start + match[0].length
  }

  text += sanitizePlainSegment(input.slice(lastIndex), strippedState => {
    stripped = stripped || strippedState
  })

  return {
    text: normalizeWhitespace(text),
    stripped,
  }
}

function sanitizePlainSegment(segment: string, onStripped: (stripped: boolean) => void): string {
  if (!segment) return ''

  let text = segment
  let stripped = false

  const markerPattern = /\bto=functions\.[A-Za-z0-9._-]+\b/g
  if (markerPattern.test(text)) {
    text = text.replace(markerPattern, ' ')
    stripped = true
  }

  const objectResult = stripSuspiciousJsonObjects(text)
  if (objectResult.stripped) {
    text = objectResult.text
    stripped = true
  }

  onStripped(stripped)
  return text
}

function stripSuspiciousJsonObjects(text: string): SanitizedChatText {
  let result = ''
  let index = 0
  let stripped = false

  while (index < text.length) {
    const start = text.indexOf('{', index)
    if (start === -1) {
      result += text.slice(index)
      break
    }

    result += text.slice(index, start)
    const end = findMatchingJsonBrace(text, start)
    if (end === null) {
      result += text.slice(start)
      break
    }

    const candidate = text.slice(start, end)
    if (looksLikeToolProtocol(candidate, text, start, end)) {
      stripped = true
      index = end
      continue
    }

    result += candidate
    index = end
  }

  return { text: result, stripped }
}

function looksLikeToolProtocol(candidate: string, text: string, start: number, end: number): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return false
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false

  const record = parsed as Record<string, unknown>
  const objectKeys = Object.keys(record)

  const hasToolNamespace = typeof record.to === 'string' && /^functions\./.test(record.to)
  const hasCallShape = typeof record.tool_call_id === 'string' || typeof record.call_id === 'string'
  const hasCommandShape = typeof record.command === 'string' && (
    typeof record.workdir === 'string' ||
    typeof record.cwd === 'string' ||
    typeof record.timeout === 'number' ||
    typeof record.timeout === 'string'
  )
  const hasFunctionShape = typeof record.name === 'string' && (typeof record.arguments === 'string' || typeof record.arguments === 'object')
  const hasToolShape = typeof record.tool === 'string' || typeof record.tool_name === 'string'

  if (hasToolNamespace || hasCallShape || hasCommandShape || (hasFunctionShape && hasToolShape)) {
    return true
  }

  if (objectKeys.length >= 2 && typeof record.command === 'string' && typeof record.arguments !== 'undefined') {
    return true
  }

  const surrounding = `${text.slice(Math.max(0, start - 24), start)}${text.slice(end, Math.min(text.length, end + 24))}`
  return /to=functions\./.test(surrounding)
}

function findMatchingJsonBrace(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return index + 1
      }
    }
  }

  return null
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+\n/g, '\n')
    .trim()
}
