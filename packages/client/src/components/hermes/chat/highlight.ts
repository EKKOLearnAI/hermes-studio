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
): string {
  const languageLabelHtml = labelLanguage
    ? `<span class="code-lang">${escapeHtml(labelLanguage)}</span>`
    : ''
  const blockClasses = ['hljs-code-block', ...extraClasses].join(' ')

  return `<pre class="${blockClasses}"><div class="code-header">${languageLabelHtml}<button type="button" class="copy-btn" data-copy-code="true">${escapeHtml(copyLabel)}</button></div><code class="hljs language-${sanitizeLanguageClass(codeClassLanguage)}">${highlighted}</code></pre>`
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

function renderUnifiedDiffCode(content: string, labelLanguage: string, copyLabel: string): string {
  const numbers: DiffLineNumbers = {}
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  const highlighted = lines
    .map((line) => {
      const classes = ['diff-line']
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

      const lineNumber = formatDiffLineNumber(line, numbers)
      const html = `<span class="${classes.join(' ')}"><span class="diff-line-number ${lineNumber.className}" aria-hidden="true">${escapeHtml(lineNumber.value)}</span><span class="diff-line-content">${escapeHtml(line || ' ')}</span></span>`
      advanceDiffLineNumber(line, numbers)
      return html
    })
    .join('')

  return renderCodeBlockWrapper(highlighted, 'diff', labelLanguage, copyLabel, ['hljs-unified-diff'])
}

export function normalizeHighlightLanguage(lang?: string): string {
  const normalized = lang?.trim().toLowerCase() || ''
  return LANGUAGE_ALIASES[normalized] || normalized
}

export function inferStructuredLanguage(content: string): string | undefined {
  try {
    JSON.parse(content)
    return 'json'
  } catch {
    return undefined
  }
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

type RenderHighlightedCodeBlockOptions = {
  maxHighlightLength?: number
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
    return renderUnifiedDiffCode(content, requestedLanguage || 'diff', copyLabel)
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

  const block = button.closest('.hljs-code-block')
  const code = block?.querySelector('code')
  const text = code?.textContent ?? ''
  if (!text) return false

  return copyTextToClipboard(text)
}
