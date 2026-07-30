import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const CLIENT_ROOT = join(process.cwd(), 'packages/client/src')

// Spacing, borders and text alignment in these components must follow the
// writing direction rather than a physical side. Guards against reintroducing
// the physical variants as the conversion spreads through the app.
const DIRECTION_AWARE_COMPONENTS = [
  'components/hermes/chat/ChatInput.vue',
  'components/hermes/chat/ChatPanel.vue',
  'components/hermes/chat/MessageItem.vue',
  'components/hermes/chat/MessageList.vue',
  'components/hermes/group-chat/GroupChatInput.vue',
  'components/hermes/group-chat/GroupChatPanel.vue',
  'components/hermes/group-chat/GroupMessageItem.vue',
  'components/layout/AppSidebar.vue',
  'components/layout/DesktopTitleBar.vue',
  'components/layout/ModelSelector.vue',
  'components/layout/SettingsCircuitBadge.vue',
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

describe('converted components use direction-aware CSS', () => {
  it('has no physical inline-axis spacing, borders or text alignment', () => {
    const offenders: string[] = []

    for (const component of DIRECTION_AWARE_COMPONENTS) {
      const source = readFileSync(join(CLIENT_ROOT, component), 'utf8')
      for (const { label, pattern } of PHYSICAL_PATTERNS) {
        const matches = source.match(pattern)
        if (matches) offenders.push(`${component}: ${label} × ${matches.length}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('actually uses the logical replacements', () => {
    const combined = DIRECTION_AWARE_COMPONENTS
      .map(component => readFileSync(join(CLIENT_ROOT, component), 'utf8'))
      .join('\n')

    for (const logical of ['margin-inline-start', 'padding-inline-start', 'border-inline-start']) {
      expect(combined, logical).toContain(logical)
    }
  })
})
