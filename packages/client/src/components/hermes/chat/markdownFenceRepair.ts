const MARKDOWN_FENCE_LANGUAGES = new Set(['md', 'markdown', 'mdown', 'mkd'])

type FenceInfo = {
  indent: string
  marker: string
  fence: string
  length: number
  info: string
}

function parseFence(line: string): FenceInfo | null {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/)
  if (!match) return null

  const [, indent, fence, rawInfo = ''] = match
  const marker = fence[0]
  const info = rawInfo.trim()

  // CommonMark permits backticks in tilde-fence info strings, but not in
  // backtick-fence info strings. Keeping this distinction prevents inline-ish
  // malformed backtick text from being promoted into a fence opener.
  if (marker === '`' && info.includes('`')) return null

  return {
    indent,
    marker,
    fence,
    length: fence.length,
    info,
  }
}

function serializeFence(fence: FenceInfo, length = fence.length, info = fence.info): string {
  return `${fence.indent}${fence.marker.repeat(length)}${info ? ` ${info}` : ''}`
}

function isMarkdownFence(fence: FenceInfo): boolean {
  const language = fence.info.split(/\s+/)[0]?.toLowerCase()
  return MARKDOWN_FENCE_LANGUAGES.has(language)
}

function isClosingFence(line: string, opener: FenceInfo): boolean {
  const fence = parseFence(line)
  return Boolean(
    fence
    && fence.marker === opener.marker
    && fence.length >= opener.length
    && fence.info === '',
  )
}

function findLastNonEmptyLine(lines: string[], start = lines.length - 1): number {
  let index = start
  while (index >= 0 && lines[index].trim() === '') {
    index -= 1
  }
  return index
}

function findFinalClosingFence(lines: string[], opener: FenceInfo, start: number): number {
  for (let i = findLastNonEmptyLine(lines); i > start; i -= 1) {
    if (isClosingFence(lines[i], opener)) {
      return i
    }
  }
  return -1
}

type OpenFence = {
  marker: string
  length: number
}

function canBalanceNestedFences(lines: string[], marker: string): boolean {
  const stack: OpenFence[] = []
  let sawFence = false

  for (const line of lines) {
    const fence = parseFence(line)
    if (!fence || fence.marker !== marker) continue

    sawFence = true
    const current = stack[stack.length - 1]
    if (fence.info === '' && current && fence.length >= current.length) {
      stack.pop()
      continue
    }

    // Inside a Markdown example, an unlabeled fence can be either a closing
    // fence or a literal nested unlabeled example opener. If there is no nested
    // opener waiting to close, treat it as the latter while evaluating a later
    // candidate closing fence for the outer example.
    stack.push({ marker: fence.marker, length: fence.length })
  }

  return sawFence && stack.length === 0
}

function findBalancedClosingFence(lines: string[], opener: FenceInfo, start: number): number {
  const candidates: number[] = []

  for (let i = start; i < lines.length; i += 1) {
    const fence = parseFence(lines[i])
    if (
      fence
      && fence.marker === opener.marker
      && fence.info === ''
      && fence.length >= opener.length
    ) {
      candidates.push(i)
    }
  }

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]
    if (canBalanceNestedFences(lines.slice(start, candidate), opener.marker)) {
      return candidate
    }
  }

  return candidates[0] ?? -1
}

function maxFenceLength(lines: string[], marker: string): number {
  let maxLength = 0
  for (const line of lines) {
    const fence = parseFence(line)
    if (fence?.marker === marker) {
      maxLength = Math.max(maxLength, fence.length)
    }
  }
  return maxLength
}

function promoteMarkdownExampleFences(lines: string[]): string[] {
  const output: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const opener = parseFence(lines[i])
    if (!opener || !isMarkdownFence(opener)) {
      output.push(lines[i])
      continue
    }

    const balancedClose = findBalancedClosingFence(lines, opener, i + 1)
    if (balancedClose === -1) {
      output.push(lines[i])
      continue
    }

    const body = lines.slice(i + 1, balancedClose)
    const innerMaxLength = maxFenceLength(body, opener.marker)
    if (innerMaxLength >= opener.length) {
      const promotedLength = innerMaxLength + 1
      output.push(serializeFence(opener, promotedLength))
      output.push(...body)
      output.push(serializeFence(opener, promotedLength, ''))
    } else {
      output.push(lines[i])
      output.push(...body)
      output.push(lines[balancedClose])
    }

    i = balancedClose
  }

  return output
}

/**
 * LLMs often wrap a complete PR draft or Markdown answer in an outer
 * ```md fence. Showing that outer wrapper as a code block makes the UI look
 * like Markdown rendering is broken: headings, lists, and inline code remain
 * literal text. Strip only that outer draft wrapper before handing content to
 * markdown-it.
 *
 * The unwrapped draft can still contain Markdown examples that themselves
 * contain fenced examples. CommonMark closes fences at the first same-marker
 * line with at least the opener length, so a malformed example like
 * ```md ... ```md ... ``` ... ``` must be normalized by making the example's
 * outer fence longer than the literal fences inside it.
 */
export function repairNestedMarkdownFences(content: string): string {
  if (!content.includes('```') && !content.includes('~~~')) return content

  const lines = content.split('\n')
  const output: string[] = []
  let changed = false

  for (let i = 0; i < lines.length; i += 1) {
    const opener = parseFence(lines[i])
    if (!opener || !isMarkdownFence(opener)) {
      output.push(lines[i])
      continue
    }

    const finalClose = findFinalClosingFence(lines, opener, i + 1)
    if (finalClose === -1) {
      output.push(lines[i])
      continue
    }

    const lastNonEmpty = findLastNonEmptyLine(lines)
    if (finalClose !== lastNonEmpty) {
      output.push(lines[i])
      continue
    }

    output.push(...promoteMarkdownExampleFences(lines.slice(i + 1, finalClose)))
    output.push(...lines.slice(finalClose + 1))
    changed = true
    break
  }

  return changed ? output.join('\n') : content
}
