import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const navSource = readFileSync(
  'packages/client/src/components/layout/PageSidebarNav.vue',
  'utf8',
)
const historyViewSource = readFileSync(
  'packages/client/src/views/hermes/HistoryView.vue',
  'utf8',
)

describe('page sidebar conversation switch', () => {
  it('places history after single chat, group chat, and workflow', () => {
    const switchStart = navSource.indexOf('conversation-switch conversation-switch--four')
    const switchSource = navSource.slice(switchStart)

    expect(switchStart).toBeGreaterThan(-1)
    expect(switchSource.indexOf('@click="openChat"')).toBeLessThan(switchSource.indexOf('@click="openGroupChat"'))
    expect(switchSource.indexOf('@click="openGroupChat"')).toBeLessThan(switchSource.indexOf('@click="openWorkflow"'))
    expect(switchSource.indexOf('@click="openWorkflow"')).toBeLessThan(switchSource.indexOf('@click="openHistory"'))
    expect(navSource.match(/@click="openHistory"/g)).toHaveLength(1)
  })

  it('shows the conversation switch on the history page', () => {
    const historyNav = historyViewSource.match(/<PageSidebarNav[\s\S]*?\/>/)?.[0] || ''

    expect(historyNav).toContain('active="history"')
    expect(historyNav).not.toContain('hide-mode-switch')
  })
})
