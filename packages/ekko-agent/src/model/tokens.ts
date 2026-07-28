import { getEncoding } from 'js-tiktoken'

const MAX_LETTER_RUN = 2_000
let cachedEncoder: ReturnType<typeof getEncoding> | null = null

export function countTextTokens(text: string): number {
  if (!text) return 0
  if (hasPathologicalRun(text)) return heuristicTokens(text)
  try {
    if (!cachedEncoder) cachedEncoder = getEncoding('cl100k_base')
    return cachedEncoder.encode(text).length
  } catch {
    return heuristicTokens(text)
  }
}

function heuristicTokens(text: string): number {
  const cjk = (text.match(/[\u2e80-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk * 1.5 + other / 4)
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
