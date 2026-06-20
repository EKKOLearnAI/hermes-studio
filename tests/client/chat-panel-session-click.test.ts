import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel session clicks', () => {
  it('switches the store when the route is already on the clicked session', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('if (chatStore.activeSessionId !== sessionId)')
    expect(source).toContain('await chatStore.switchSession(sessionId)')
  })
})
