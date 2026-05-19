import { beforeEach, describe, expect, it, vi } from 'vitest'

const highlightJsMock = vi.hoisted(() => ({
  getLanguage: vi.fn((lang?: string) => ['shell', 'xml', 'yaml', 'bash', 'json'].includes(lang || '')),
  highlight: vi.fn((content: string, { language }: { language: string }) => ({
    value: `<span class="mock-${language}">${content}</span>`,
  })),
  registerLanguage: vi.fn(),
}))

vi.mock('highlight.js', () => ({
  default: highlightJsMock,
}))

import { normalizeHighlightLanguage, renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'

describe('highlight helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
