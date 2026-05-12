import { describe, expect, it } from 'vitest'

import { renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'
import { normalizeToolName, sanitizeHermesChatText } from '@/utils/chat-protocol'

describe('highlight safety', () => {
  it('escapes large unknown code content', () => {
    const html = renderHighlightedCodeBlock('<img src=x onerror=alert(1)>'.repeat(100), 'unknown', 'Copy')

    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })

  it('does not emit executable HTML for known-language code', () => {
    const html = renderHighlightedCodeBlock('<script>alert(1)</script>', 'xml', 'Copy')

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;')
  })

  it('escapes the language label', () => {
    const html = renderHighlightedCodeBlock('x'.repeat(5000), '<script>alert(1)</script>', 'Copy')

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('sanitizes the language class', () => {
    const html = renderHighlightedCodeBlock('x'.repeat(5000), 'foo bar"><img', 'Copy')

    expect(html).toContain('language-foo-bar---img')
  })

  it('escapes the copy label', () => {
    const html = renderHighlightedCodeBlock('x', 'json', 'Copy <now>')

    expect(html).toContain('Copy &lt;now&gt;')
    expect(html).not.toContain('Copy <now>')
  })

  it('strips leaked tool protocol fragments from plain assistant text', () => {
    const sanitized = sanitizeHermesChatText('你好 我动了你很多源码怎么办呢? {"command":"git status","timeout":60,"workdir":"/mnt/e/agents/hermes/source"} to=functions.terminal')

    expect(sanitized.stripped).toBe(true)
    expect(sanitized.text).toContain('你好 我动了你很多源码怎么办呢?')
    expect(sanitized.text).not.toContain('command')
    expect(sanitized.text).not.toContain('to=functions.terminal')
  })

  it('normalizes function namespace tool names', () => {
    expect(normalizeToolName('functions.terminal')).toBe('terminal')
    expect(normalizeToolName('terminal')).toBe('terminal')
  })
})
