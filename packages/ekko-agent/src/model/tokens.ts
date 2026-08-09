import { getEncoding } from 'js-tiktoken'

const MAX_LETTER_RUN = 2_000
const MAX_EXACT_TOKEN_TEXT_BYTES = 256 * 1024
const MAX_HEURISTIC_SCAN_TEXT_UNITS = 8 * 1024 * 1024
let cachedEncoder: ReturnType<typeof getEncoding> | null = null

export function countTextTokens(text: string): number {
  if (!text) return 0
  if (exceedsExactTokenBudget(text) || hasPathologicalRun(text)) return heuristicTokens(text)
  try {
    if (!cachedEncoder) cachedEncoder = getEncoding('cl100k_base')
    return cachedEncoder.encode(text).length
  } catch {
    return heuristicTokens(text)
  }
}

function heuristicTokens(text: string): number {
  if (text.length > MAX_HEURISTIC_SCAN_TEXT_UNITS) return text.length * 3
  return Buffer.byteLength(text, 'utf8')
}

function exceedsExactTokenBudget(text: string): boolean {
  if (text.length > MAX_EXACT_TOKEN_TEXT_BYTES) return true
  return text.length > MAX_EXACT_TOKEN_TEXT_BYTES / 3
    && Buffer.byteLength(text, 'utf8') > MAX_EXACT_TOKEN_TEXT_BYTES
}

function hasPathologicalRun(text: string): boolean {
  let run = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const isLetter =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code > 0x2e7f
    run = isLetter ? run + 1 : 0
    if (run > MAX_LETTER_RUN) return true
  }
  return false
}
