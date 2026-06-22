import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel session clicks', () => {
  it('switches the store when the route is already on the clicked session', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('if (chatStore.activeSessionId !== sessionId)')
    expect(source).toContain('await chatStore.switchSession(sessionId)')
  })

  it('allows session model switching for coding agent sessions', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('contextSession.value?.source === "coding_agent"')
    expect(source).toContain('isSessionModelScopedCodingAgent')
    expect(source).toContain('!isCodingAgentAuthProvider(group.provider)')
    expect(source).toContain('showSessionModelModeModal')
    expect(source).toContain('pendingSessionModelSwitch')
    expect(source).toContain('chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode)')
    expect(source).not.toContain('header-model-button--readonly')
    expect(source).not.toContain('if (isActiveSessionCodingAgent.value) return')
  })
})
