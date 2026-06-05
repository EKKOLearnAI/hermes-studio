import hljs from 'highlight.js'
import { copyToClipboard } from '@/utils/clipboard'

const LANGUAGE_ALIASES: Record<string, string> = {
  shellscript: 'bash',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  vue: 'xml',
}

const UNIFIED_DIFF_LANGUAGES = new Set(['diff', 'patch'])
const DIFF_CONTEXT_FOLD_THRESHOLD = 8
const DIFF_CONTEXT_FOLD_EDGE_LINES = 3
const DIFF_PAYLOAD_FIELD_NAMES = new Set([
  'difference',
  'diff',
  'patch',
  'stdout',
  'output',
  'content',
])

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sanitizeLanguageClass(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '-') || 'plain'
}

function renderCodeBlockWrapper(
  highlighted: string,
  codeClassLanguage: string,
  labelLanguage: string | undefined,
  copyLabel: string,
  extraClasses: string[] = [],
  rawCopyText?: string,
): string {
  const languageLabelHtml = labelLanguage
    ? `<span class="code-lang">${escapeHtml(labelLanguage)}</span>`
    : ''
  const blockClasses = ['hljs-code-block', ...extraClasses].join(' ')
  const copyTextAttr = rawCopyText == null
    ? ''
    : ` data-copy-text="${escapeHtml(rawCopyText)}"`

  return `<pre class="${blockClasses}"${copyTextAttr}><div class="code-header">${languageLabelHtml}<button type="button" class="copy-btn" data-copy-code="true">${escapeHtml(copyLabel)}</button></div><code class="hljs language-${sanitizeLanguageClass(codeClassLanguage)}">${highlighted}</code></pre>`
}

function isUnifiedDiffLanguage(lang?: string): boolean {
  return UNIFIED_DIFF_LANGUAGES.has(lang?.trim().toLowerCase() || '')
}

function isDiffFileHeader(line: string): boolean {
  return /^(diff --git |index |---(?:\s|$)|\+\+\+(?:\s|$))/.test(line)
}

function isDiffHunkHeader(line: string): boolean {
  return /^@@(?:\s|$)/.test(line)
}

function isDiffAddedLine(line: string): boolean {
  return /^\+(?!\+\+(?:\s|$))/.test(line)
}

function isDiffRemovedLine(line: string): boolean {
  return /^-(?!---(?:\s|$))/.test(line)
}

type DiffLineNumbers = {
  oldNumber?: number
  newNumber?: number
}

type RenderedDiffLine = {
  html: string
  foldableContext: boolean
}

function parseDiffHunkHeader(line: string): DiffLineNumbers | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  if (!match) return null
  return {
    oldNumber: Number(match[1]),
    newNumber: Number(match[2]),
  }
}

function formatDiffLineNumber(line: string, numbers: DiffLineNumbers): { value: string; className: string } {
  if (isDiffFileHeader(line) || isDiffHunkHeader(line)) {
    return { value: '', className: 'diff-line-number-empty' }
  }
  if (isDiffRemovedLine(line)) {
    return {
      value: numbers.oldNumber != null ? String(numbers.oldNumber) : '',
      className: 'diff-line-number-old',
    }
  }
  if (isDiffAddedLine(line)) {
    return {
      value: numbers.newNumber != null ? String(numbers.newNumber) : '',
      className: 'diff-line-number-new',
    }
  }
  if (!isDiffFileHeader(line) && !isDiffHunkHeader(line) && numbers.newNumber != null) {
    return {
      value: String(numbers.newNumber),
      className: 'diff-line-number-context',
    }
  }
  return { value: '', className: 'diff-line-number-empty' }
}

function advanceDiffLineNumber(line: string, numbers: DiffLineNumbers): void {
  if (isDiffFileHeader(line) || isDiffHunkHeader(line)) return
  if (isDiffRemovedLine(line)) {
    if (numbers.oldNumber != null) numbers.oldNumber += 1
    return
  }
  if (isDiffAddedLine(line)) {
    if (numbers.newNumber != null) numbers.newNumber += 1
    return
  }
  if (numbers.oldNumber != null) numbers.oldNumber += 1
  if (numbers.newNumber != null) numbers.newNumber += 1
}

function renderDiffContextFoldLine(foldLabel: string): string {
  return `<span class="diff-line diff-line-context-fold"><span class="diff-line-number diff-line-number-empty" aria-hidden="true"></span><span class="diff-line-content">⋮ ${escapeHtml(foldLabel)}</span></span>`
}

function collapseFoldableContextRows(
  rows: RenderedDiffLine[],
  formatFoldLabel: (hiddenCount: number) => string,
): RenderedDiffLine[] {
  const folded: RenderedDiffLine[] = []
  let index = 0

  while (index < rows.length) {
    if (!rows[index].foldableContext) {
      folded.push(rows[index])
      index += 1
      continue
    }

    const runStart = index
    while (index < rows.length && rows[index].foldableContext) index += 1
    const run = rows.slice(runStart, index)

    if (run.length <= DIFF_CONTEXT_FOLD_THRESHOLD) {
      folded.push(...run)
      continue
    }

    const edge = Math.min(DIFF_CONTEXT_FOLD_EDGE_LINES, Math.floor(run.length / 2))
    const hiddenCount = run.length - edge * 2
    folded.push(...run.slice(0, edge))
    folded.push({
      html: renderDiffContextFoldLine(formatFoldLabel(hiddenCount)),
      foldableContext: false,
    })
    folded.push(...run.slice(run.length - edge))
  }

  return folded
}

function renderUnifiedDiffCode(
  content: string,
  labelLanguage: string,
  copyLabel: string,
  formatFoldLabel: (hiddenCount: number) => string,
): string {
  const numbers: DiffLineNumbers = {}
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  const renderedRows = lines
    .map((line) => {
      const classes = ['diff-line']
      let foldableContext = false
      if (isDiffFileHeader(line)) classes.push('diff-line-file-header')
      else if (isDiffHunkHeader(line)) {
        classes.push('diff-line-hunk-header')
        const hunkNumbers = parseDiffHunkHeader(line)
        if (hunkNumbers) {
          numbers.oldNumber = hunkNumbers.oldNumber
          numbers.newNumber = hunkNumbers.newNumber
        }
      }
      else if (isDiffAddedLine(line)) classes.push('diff-line-added')
      else if (isDiffRemovedLine(line)) classes.push('diff-line-removed')
      else foldableContext = true

      const lineNumber = formatDiffLineNumber(line, numbers)
      const html = `<span class="${classes.join(' ')}"><span class="diff-line-number ${lineNumber.className}" aria-hidden="true">${escapeHtml(lineNumber.value)}</span><span class="diff-line-content">${escapeHtml(line || ' ')}</span></span>`
      advanceDiffLineNumber(line, numbers)
      return { html, foldableContext }
    })

  const highlighted = collapseFoldableContextRows(renderedRows, formatFoldLabel)
    .map((row) => row.html)
    .join('')

  return renderCodeBlockWrapper(highlighted, 'diff', labelLanguage, copyLabel, ['hljs-unified-diff'], content)
}

export function normalizeHighlightLanguage(lang?: string): string {
  const normalized = lang?.trim().toLowerCase() || ''
  return LANGUAGE_ALIASES[normalized] || normalized
}

function looksLikeDiff(content: string): boolean {
  const trimmed = content.trimStart()
  if (/^\*\*\* Begin Patch/m.test(trimmed)) return true
  if (/^\*\*\* (Update|Add|Delete) File:/m.test(trimmed)) return true
  if (/^---\s+[^\n]+\n\+\+\+\s+[^\n]+\n@@/m.test(trimmed)) return true
  return false
}

export function inferStructuredLanguage(content: string): string | undefined {
  const trimmed = content.trimStart()
  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(content)
      return 'json'
    } catch {
      // Fall through to diff/text detection.
    }
  }
  return looksLikeDiff(content) ? 'diff' : undefined
}

export function isUnifiedDiffContent(content: string, lang?: string): boolean {
  const lines = content.split(/\r?\n/)
  if (lines.length < 3) return false

  let fileHeaders = 0
  let hunkHeaders = 0
  let addedLines = 0
  let removedLines = 0
  let diffHeaders = 0

  for (const line of lines) {
    if (/^(diff --git |index )/.test(line)) {
      diffHeaders += 1
      continue
    }
    if (/^---(?:\s|$)|^\+\+\+(?:\s|$)/.test(line)) {
      fileHeaders += 1
      continue
    }
    if (isDiffHunkHeader(line)) {
      hunkHeaders += 1
      continue
    }
    if (isDiffAddedLine(line)) {
      addedLines += 1
      continue
    }
    if (isDiffRemovedLine(line)) {
      removedLines += 1
    }
  }

  const hasChangedLines = addedLines > 0 || removedLines > 0
  if (!hasChangedLines) return false

  if (isUnifiedDiffLanguage(lang)) {
    return hunkHeaders > 0 || fileHeaders >= 2 || diffHeaders > 0
  }

  return fileHeaders >= 2 && hunkHeaders > 0
}

export function extractUnifiedDiffPayload(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const diff = extractUnifiedDiffPayload(item, depth + 1)
      if (diff) return diff
    }
    return null
  }

  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, candidate] of entries) {
    if (
      DIFF_PAYLOAD_FIELD_NAMES.has(key.toLowerCase())
      && typeof candidate === 'string'
      && isUnifiedDiffContent(candidate)
    ) {
      return candidate
    }
  }

  for (const [, candidate] of entries) {
    if (candidate && typeof candidate === 'object') {
      const diff = extractUnifiedDiffPayload(candidate, depth + 1)
      if (diff) return diff
    }
  }

  return null
}

type RenderHighlightedCodeBlockOptions = {
  maxHighlightLength?: number
  formatDiffFoldLabel?: (hiddenCount: number) => string
}

export function renderHighlightedCodeBlock(
  content: string,
  lang: string | undefined,
  copyLabel: string,
  options: RenderHighlightedCodeBlockOptions = {},
): string {
  const requestedLanguage = lang?.trim().toLowerCase() || ''
  const normalizedLanguage = normalizeHighlightLanguage(requestedLanguage)
  const highlightLimit = options.maxHighlightLength ?? Number.POSITIVE_INFINITY

  if (isUnifiedDiffContent(content, requestedLanguage || normalizedLanguage)) {
    const formatDiffFoldLabel = options.formatDiffFoldLabel ?? ((hiddenCount: number) => String(hiddenCount))
    return renderUnifiedDiffCode(content, requestedLanguage || 'diff', copyLabel, formatDiffFoldLabel)
  }

  let highlighted = ''
  let codeClassLanguage = normalizedLanguage || requestedLanguage || 'plain'
  let labelLanguage = requestedLanguage

  try {
    if (normalizedLanguage && hljs.getLanguage(normalizedLanguage) && content.length <= highlightLimit) {
      highlighted = hljs.highlight(content, {
        language: normalizedLanguage,
        ignoreIllegals: true,
      }).value
      codeClassLanguage = normalizedLanguage
    } else {
      highlighted = escapeHtml(content)
      if (!labelLanguage) {
        labelLanguage = 'text'
      }
    }
  } catch {
    highlighted = escapeHtml(content)
    if (!labelLanguage) {
      labelLanguage = 'text'
    }
  }

  return renderCodeBlockWrapper(highlighted, codeClassLanguage, labelLanguage, copyLabel)
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  return copyToClipboard(text)
}

export async function handleCodeBlockCopyClick(event: MouseEvent): Promise<boolean | null> {
  const target = event.target
  if (!(target instanceof HTMLElement)) return null

  const button = target.closest<HTMLElement>('[data-copy-code="true"]')
  if (!button) return null

  event.preventDefault()

  const block = button.closest<HTMLElement>('.hljs-code-block')
  const code = block?.querySelector('code')
  const text = block?.getAttribute('data-copy-text') ?? code?.textContent ?? ''
  if (!text) return false

  return copyTextToClipboard(text)
}
