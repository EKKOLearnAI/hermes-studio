import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import xml from 'highlight.js/lib/languages/xml'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import r from 'highlight.js/lib/languages/r'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import yaml from 'highlight.js/lib/languages/yaml'
import plaintext from 'highlight.js/lib/languages/plaintext'
import { copyToClipboard } from '@/utils/clipboard'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('css', css)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('go', go)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('lua', lua)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('php', php)
hljs.registerLanguage('python', python)
hljs.registerLanguage('r', r)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('scss', scss)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('plaintext', plaintext)

const LANGUAGE_ALIASES: Record<string, string> = {
  shellscript: 'bash',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  vue: 'xml',
}

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

  const languageLabelHtml = labelLanguage
    ? `<span class="code-lang">${escapeHtml(labelLanguage)}</span>`
    : ''

  return `<pre class="hljs-code-block"><div class="code-header">${languageLabelHtml}<button type="button" class="copy-btn" data-copy-code="true">${escapeHtml(copyLabel)}</button></div><code class="hljs language-${sanitizeLanguageClass(codeClassLanguage)}">${highlighted}</code></pre>`
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
