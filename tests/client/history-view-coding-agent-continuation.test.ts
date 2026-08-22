import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const historyView = readFileSync('packages/client/src/views/hermes/HistoryView.vue', 'utf8')

describe('History coding-agent continuation', () => {
  it('routes coding-agent history sessions into the live chat view', () => {
    expect(historyView).toContain('const canContinueActiveSession = computed(() => isCodingAgentHistorySession(historySession.value))')
    expect(historyView).toContain("session?.source === 'coding_agent'")
    expect(historyView).toContain("session?.agent === 'claude'")
    expect(historyView).toContain("session?.agent === 'codex'")
    expect(historyView).toContain("name: 'hermes.session'")
    expect(historyView).toContain("key: 'continue-chat'")
    expect(historyView).toContain("t('chat.continueInChat')")
  })

  it('offers source filtering for Web, Claude CLI, and Codex CLI history', () => {
    expect(historyView).toContain('const historySourceFilterOptions = computed')
    expect(historyView).toContain("value: 'cli'")
    expect(historyView).toContain("value: 'claude'")
    expect(historyView).toContain("value: 'codex'")
    expect(historyView).toContain('effectiveHistorySource.value,')
  })
})
