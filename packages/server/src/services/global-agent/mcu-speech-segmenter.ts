import { cleanTtsText } from '../hermes/tts-providers/text'

const DEFAULT_MAX_SEGMENT_CHARS = 90
const MIN_SEGMENT_CHARS = 24
const SENTENCE_BOUNDARY_RE = /[。！？!?]/
const SOFT_BOUNDARY_RE = /[，,；;、\n]/

export interface McuSpeechSegmenter {
  pushDelta(delta: string): string[]
  flush(): string | null
  reset(): void
}

export interface McuSpeechSegmenterOptions {
  maxChars?: number
}

interface BoundaryScan {
  sentenceBoundary: number
  softBoundary: number
}

export function normalizeMcuSpeechText(text: string): string {
  const withoutTables = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>)\]]+/gi, ' ')
    .replace(/www\.[^\s<>)\]]+/gi, ' ')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      const pipeCount = (trimmed.match(/\|/g) || []).length
      if (pipeCount >= 2) return false
      if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) return false
      return true
    })
    .join('\n')

  return cleanTtsText(withoutTables)
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function advancePastTrailingClosers(text: string, index: number): number {
  let end = index
  while (end < text.length && /[\s"'”’）)\]】》]/.test(text[end])) {
    end += 1
  }
  return end
}

function scanBoundaries(text: string): BoundaryScan {
  let sentenceBoundary = -1
  let softBoundary = -1
  let inFence = false
  let inInlineCode = false
  let inLinkText = false
  let inLinkUrl = false
  let inUrl = false

  for (let i = 0; i < text.length; i += 1) {
    const rest = text.slice(i)

    if (rest.startsWith('```')) {
      inFence = !inFence
      i += 2
      continue
    }

    if (inFence) continue

    const char = text[i]

    if (char === '`') {
      inInlineCode = !inInlineCode
      continue
    }
    if (inInlineCode) continue

    if (inLinkUrl) {
      if (char === ')') inLinkUrl = false
      continue
    }

    if (inUrl) {
      if (/\s/.test(char)) inUrl = false
      else continue
    }

    if (rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('www.')) {
      inUrl = true
      if (rest.startsWith('https://')) i += 7
      else if (rest.startsWith('http://')) i += 6
      else i += 3
      continue
    }
    if (inLinkText) {
      if (char === ']' && text[i + 1] === '(') {
        inLinkText = false
        inLinkUrl = true
        i += 1
      }
      continue
    }
    if (char === '[') {
      inLinkText = true
      continue
    }

    if (SENTENCE_BOUNDARY_RE.test(char)) {
      sentenceBoundary = advancePastTrailingClosers(text, i + 1)
    } else if (SOFT_BOUNDARY_RE.test(char)) {
      softBoundary = advancePastTrailingClosers(text, i + 1)
    }
  }

  return { sentenceBoundary, softBoundary }
}

export function createMcuSpeechSegmenter(options: McuSpeechSegmenterOptions = {}): McuSpeechSegmenter {
  const maxChars = Math.max(MIN_SEGMENT_CHARS, options.maxChars || DEFAULT_MAX_SEGMENT_CHARS)
  let buffer = ''

  function takeReadySegments(force = false): string[] {
    const segments: string[] = []

    while (buffer.length > 0) {
      const boundaries = scanBoundaries(buffer)
      let end = boundaries.sentenceBoundary

      if (end < 0 && buffer.length >= maxChars) {
        end = boundaries.softBoundary
      }
      if (end < 0 && force) {
        end = buffer.length
      }
      if (end < 0) break

      const rawSegment = buffer.slice(0, end)
      buffer = buffer.slice(end)
      const segment = normalizeMcuSpeechText(rawSegment)
      if (segment) segments.push(segment)
    }

    return segments
  }

  return {
    pushDelta(delta: string) {
      if (!delta) return []
      buffer += delta
      return takeReadySegments(false)
    },
    flush() {
      const segments = takeReadySegments(true)
      return segments.length > 0 ? segments.join(' ') : null
    },
    reset() {
      buffer = ''
    },
  }
}
