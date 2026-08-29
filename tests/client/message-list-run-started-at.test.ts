import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * MessageList is asserted against source, the way
 * tests/client/chat-panel-session-click.test.ts already does — mounting it
 * drags in the whole chat surface.
 */
describe('thinking timer watcher', () => {
  const source = readFileSync('packages/client/src/components/hermes/chat/MessageList.vue', 'utf8')

  it('restarts when the session or its reported start changes, not only when the indicator flips', () => {
    const watched = source.slice(source.indexOf('watch(\n  // Switching between two sessions'))
    expect(watched).toContain('isRunIndicatorActive.value')
    expect(watched).toContain('chatStore.activeSessionId')
    expect(watched).toContain('chatStore.runStartedAt.get(chatStore.activeSessionId)')
  })

  it('uses the reported start as the origin, falls back to Date.now(), and never displays a negative time', () => {
    expect(source).toContain('thinkingStartedAt = reportedStart > 0 ? reportedStart : Date.now()')
    expect(source.match(/thinkingElapsedMs\.value = Math\.max\(0, Date\.now\(\) - thinkingStartedAt\)/g)).toHaveLength(2)
  })
})
