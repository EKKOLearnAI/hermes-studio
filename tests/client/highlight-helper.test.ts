// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const highlightJsMock = vi.hoisted(() => ({
  getLanguage: vi.fn((lang?: string) => ['shell', 'xml', 'yaml', 'bash', 'json'].includes(lang || '')),
  highlight: vi.fn((content: string, { language }: { language: string }) => ({
    value: `<span class="mock-${language}">${content}</span>`,
  })),
  registerLanguage: vi.fn(),
}))

const copyToClipboardMock = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>(async () => true))

vi.mock('highlight.js', () => ({
  default: highlightJsMock,
}))

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: copyToClipboardMock,
}))

import {
  extractUnifiedDiffPayload,
  handleCodeBlockCopyClick,
  inferStructuredLanguage,
  isUnifiedDiffContent,
  normalizeHighlightLanguage,
  renderHighlightedCodeBlock,
} from '@/components/hermes/chat/highlight'

const UNIFIED_DIFF_SAMPLE = `diff --git a/foo.ts b/foo.ts
index 1111111..2222222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
-const value = 1
+const value = 2
 console.log(value)
`

describe('highlight helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    copyToClipboardMock.mockResolvedValue(true)
    highlightJsMock.getLanguage.mockImplementation((lang?: string) => ['shell', 'xml', 'yaml', 'bash', 'json'].includes(lang || ''))
    highlightJsMock.highlight.mockImplementation((content: string, { language }: { language: string }) => ({
      value: `<span class="mock-${language}">${content}</span>`,
    }))
  })

  it.each([
    ['vue', 'xml'],
    ['yml', 'yaml'],
    ['sh', 'bash'],
    ['zsh', 'bash'],
    ['shellscript', 'bash'],
    ['shell', 'shell'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeHighlightLanguage(input)).toBe(expected)
  })

  it('uses a delegated copy attribute instead of inline javascript', () => {
    const html = renderHighlightedCodeBlock('x', 'json', 'Copy')

    expect(html).toContain('data-copy-code="true"')
    expect(html).not.toContain('onclick=')
  })


  it('infers patch-style raw payloads as diff', () => {
    expect(inferStructuredLanguage([
      '*** Begin Patch',
      '*** Update File: demo.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'))).toBe('diff')
  })

  it('does not infer primitive JSON-looking text as json', () => {
    expect(inferStructuredLanguage('false')).toBeUndefined()
    expect(inferStructuredLanguage('0')).toBeUndefined()
  })

  it('infers unified diff payloads as diff', () => {
    expect(inferStructuredLanguage([
      '--- a/demo.ts',
      '+++ b/demo.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'))).toBe('diff')
  })

  it('preserves shell-session highlighting instead of remapping shell fences to bash', () => {
    const html = renderHighlightedCodeBlock('$ ls\nfoo.txt\n', 'shell', 'Copy')

    expect(highlightJsMock.highlight).toHaveBeenCalledWith('$ ls\nfoo.txt\n', {
      language: 'shell',
      ignoreIllegals: true,
    })
    expect(html).toContain('class="code-lang">shell</span>')
  })

  it('skips highlighting for large known-language blocks when a render limit is set', () => {
    const html = renderHighlightedCodeBlock('x'.repeat(5000), 'vue', 'Copy', {
      maxHighlightLength: 2000,
    })

    expect(highlightJsMock.highlight).not.toHaveBeenCalled()
    expect(html).toContain('class="code-lang">vue</span>')
  })

  it('falls back to escaped plaintext for unsupported fence labels', () => {
    const html = renderHighlightedCodeBlock('<tag>', 'unknown', 'Copy')

    expect(highlightJsMock.highlight).not.toHaveBeenCalled()
    expect(html).toContain('&lt;tag&gt;')
    expect(html).toContain('class="code-lang">unknown</span>')
  })

  it('falls back to escaped plaintext when direct highlighting throws', () => {
    highlightJsMock.highlight.mockImplementationOnce(() => {
      throw new Error('boom')
    })

    const html = renderHighlightedCodeBlock('<tag>', 'vue', 'Copy')

    expect(html).toContain('&lt;tag&gt;')
    expect(html).toContain('class="code-lang">vue</span>')
  })

  it('detects unified diff content conservatively', () => {
    expect(isUnifiedDiffContent(UNIFIED_DIFF_SAMPLE)).toBe(true)
    expect(isUnifiedDiffContent('--- note\n+++ more\nplain text')).toBe(false)
    expect(isUnifiedDiffContent('@@ -1 +1 @@\n-a\n+b', 'diff')).toBe(true)
  })

  it('extracts unified diffs from JSON payload fields shared by chat and group chat renderers', () => {
    const nestedDiff = {
      ok: true,
      result: {
        difference: UNIFIED_DIFF_SAMPLE,
      },
    }

    expect(extractUnifiedDiffPayload(nestedDiff)).toBe(UNIFIED_DIFF_SAMPLE)
    expect(extractUnifiedDiffPayload({ difference: 'not a diff' })).toBeNull()
  })

  it('renders unified diffs with semantic rows, line numbers, and no highlight.js execution', () => {
    const html = renderHighlightedCodeBlock(UNIFIED_DIFF_SAMPLE, undefined, 'Copy')

    expect(highlightJsMock.highlight).not.toHaveBeenCalled()
    expect(html).toContain('hljs-unified-diff')
    expect(html).toContain('class="code-lang">diff</span>')
    expect(html).toContain('diff-line diff-line-file-header')
    expect(html).toContain('diff-line diff-line-hunk-header')
    expect(html).toContain('diff-line diff-line-removed')
    expect(html).toContain('diff-line diff-line-added')
    expect(html).toContain('class="diff-line-number diff-line-number-old" aria-hidden="true">1</span>')
    expect(html).toContain('class="diff-line-number diff-line-number-new" aria-hidden="true">1</span>')
    expect(html).toContain('class="diff-line-number diff-line-number-context" aria-hidden="true">2</span>')
    expect(html).toContain('class="diff-line-content">-const value = 1</span>')
    expect(html).toContain('class="diff-line-content">+const value = 2</span>')
  })

  it('renders unified diff rows without newline text nodes between block rows', () => {
    const html = renderHighlightedCodeBlock(UNIFIED_DIFF_SAMPLE, undefined, 'Copy')

    expect(html).not.toContain('</span>\n<span class="diff-line')
  })

  it('collapses long unchanged context runs in unified diffs by default', () => {
    const contextLines = Array.from({ length: 12 }, (_, index) => ` unchanged ${index + 1}`).join('\n')
    const sample = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -10,14 +10,14 @@\n${contextLines}\n-old value\n+new value\n`

    const html = renderHighlightedCodeBlock(sample, 'diff', 'Copy', {
      formatDiffFoldLabel: (hiddenCount) => `${hiddenCount} unchanged lines`,
    })

    expect(html).toContain('diff-line-context-fold')
    expect(html).toContain('6 unchanged lines')
    expect(html).toContain(' unchanged 1')
    expect(html).toContain(' unchanged 3')
    expect(html).toContain(' unchanged 10')
    expect(html).toContain(' unchanged 12')
    expect(html).not.toContain(' unchanged 4</span>')
    expect(html).not.toContain(' unchanged 9</span>')
    expect(html).toContain('data-copy-text=')
    expect(html).toContain(' unchanged 4\n unchanged 5')
    expect(html).toContain('-old value')
    expect(html).toContain('+new value')
  })

  it('copies the full original unified diff after context folding', async () => {
    const contextLines = Array.from({ length: 12 }, (_, index) => ` unchanged ${index + 1}`).join('\n')
    const sample = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -10,14 +10,14 @@\n${contextLines}\n-old value\n+new value\n`
    const container = document.createElement('div')
    container.innerHTML = renderHighlightedCodeBlock(sample, 'diff', 'Copy', {
      formatDiffFoldLabel: (hiddenCount) => `${hiddenCount} unchanged lines`,
    })
    const button = container.querySelector<HTMLElement>('[data-copy-code="true"]')!

    const copied = await handleCodeBlockCopyClick(new MouseEvent('click', { bubbles: true }))
    expect(copied).toBeNull()

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: button })

    await expect(handleCodeBlockCopyClick(event)).resolves.toBe(true)
    expect(copyToClipboardMock).toHaveBeenCalledWith(sample)
    const copiedText = copyToClipboardMock.mock.lastCall?.[0] || ''
    expect(copiedText).toContain(' unchanged 4')
    expect(copiedText).not.toContain('unchanged lines')
  })
})
