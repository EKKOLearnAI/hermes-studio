export interface ParsedThinking {
  segments: string[]
  pending: string | null
  body: string
  hasThinking: boolean
}

export interface ParseOptions {
  streaming: boolean
}

const TAG_RE = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi

export function parseThinking(content: string, opts: ParseOptions): ParsedThinking {
  const segments: string[] = []
  let pending: string | null = null
  let body = ''
  let lastIndex = 0

  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(content)) !== null) {
    body += content.slice(lastIndex, m.index)
    segments.push(m[2])
    lastIndex = m.index + m[0].length
  }
  const rest = content.slice(lastIndex)

  const openRe = /<(think|thinking|reasoning)>([\s\S]*)$/i
  const openMatch = rest.match(openRe)
  if (openMatch) {
    body += rest.slice(0, openMatch.index)
    if (opts.streaming) {
      pending = openMatch[2]
    } else {
      body += rest.slice(openMatch.index!)
    }
  } else {
    body += rest
  }

  return {
    segments,
    pending,
    body,
    hasThinking: segments.length > 0 || pending !== null,
  }
}
