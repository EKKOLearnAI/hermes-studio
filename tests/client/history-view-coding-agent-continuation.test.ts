import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const historyView = readFileSync('packages/client/src/views/hermes/HistoryView.vue', 'utf8')

describe('History coding-agent continuation', () => {
  it('routes coding-agent history sessions into the live chat view', () => {
    expect(historyView).toContain("const canContinueActiveSession = computed(() => historySession.value?.source === 'coding_agent')")
    expect(historyView).toContain("name: 'hermes.session'")
    expect(historyView).toContain("key: 'continue-chat'")
    expect(historyView).toContain("t('chat.continueInChat')")
  })
})
