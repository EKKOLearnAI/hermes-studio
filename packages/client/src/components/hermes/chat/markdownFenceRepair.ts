const MARKDOWN_FENCE_LANGUAGES = new Set(['md', 'markdown', 'mdown', 'mkd'])

type FenceInfo = {
  indent: string
  marker: string
  fence: string
  length: number
  info: string
}

function parseFence(line: string): FenceInfo | null {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})([^`~]*)$/)
  if (!match) return null

  const [, indent, fence, info = ''] = match
  return {
    indent,
    marker: fence[0],
    fence,
    length: fence.length,
    info: info.trim(),
  }
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

/**
 * LLMs often wrap a complete PR draft or Markdown answer in an outer
 * ```md fence. Showing that outer wrapper as a code block makes the UI look
 * like Markdown rendering is broken: headings, lists, and inline code remain
 * literal text. Strip only that outer draft wrapper before handing content to
 * markdown-it. Inner fenced examples remain intact and render as code blocks.
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

    output.push(...lines.slice(i + 1, finalClose))
    output.push(...lines.slice(finalClose + 1))
    changed = true
    break
  }

  return changed ? output.join('\n') : content
}
