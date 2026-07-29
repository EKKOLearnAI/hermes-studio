import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const CHAT_ROOT = join(process.cwd(), 'packages/client/src/components/hermes/chat')

// The chat surface is the most text-heavy part of the UI, so its spacing,
// borders and text alignment must follow the writing direction rather than a
// physical side. Guards against reintroducing the physical variants.
const CHAT_COMPONENTS = [
  'ChatInput.vue',
  'ChatPanel.vue',
  'MessageItem.vue',
  'MessageList.vue',
]

const PHYSICAL_PATTERNS: Array<{ label: string, pattern: RegExp }> = [
  { label: 'margin-left', pattern: /\bmargin-left\b/g },
  { label: 'margin-right', pattern: /\bmargin-right\b/g },
  { label: 'padding-left', pattern: /\bpadding-left\b/g },
  { label: 'padding-right', pattern: /\bpadding-right\b/g },
  { label: 'border-left', pattern: /\bborder-left\b/g },
  { label: 'border-right', pattern: /\bborder-right\b/g },
  { label: 'text-align: left', pattern: /text-align:\s*left\b/g },
  { label: 'text-align: right', pattern: /text-align:\s*right\b/g },
]

describe('chat surface uses direction-aware CSS', () => {
  it('has no physical inline-axis spacing, borders or text alignment', () => {
    const offenders: string[] = []

    for (const component of CHAT_COMPONENTS) {
      const source = readFileSync(join(CHAT_ROOT, component), 'utf8')
      for (const { label, pattern } of PHYSICAL_PATTERNS) {
        const matches = source.match(pattern)
        if (matches) offenders.push(`${component}: ${label} × ${matches.length}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('actually uses the logical replacements', () => {
    const combined = CHAT_COMPONENTS
      .map(component => readFileSync(join(CHAT_ROOT, component), 'utf8'))
      .join('\n')

    for (const logical of ['margin-inline-start', 'padding-inline-start', 'border-inline-start']) {
      expect(combined, logical).toContain(logical)
    }
  })
})
