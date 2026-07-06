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

  it('uses codingAgentId when deciding whether session model switches need an API mode', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('const sessionModelCodingAgentId = computed<ChatCodingAgentId | undefined>')
    expect(source).toContain('sessionModelSession.value?.codingAgentId ||')
    expect(source).toContain('sessionModelSession.value?.agent === "claude"')
    expect(source).toContain('sessionModelCodingAgentId.value === "claude-code"')
    expect(source).not.toContain('sessionModelSession.value?.agent === "claude-code"')
  })

  it('uses the active sidebar model as the new chat default for the active profile', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('const selectedProvider = appStore.selectedProvider || ""')
    expect(source).toContain('const selectedModel = appStore.selectedModel || ""')
    expect(source).toContain('profile === activeProfileName')
    expect(source).toContain('selectedGroup?.models.includes(selectedModel)')
  })

  it('uses a create action in the new chat drawer instead of duplicating the new chat trigger label', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('{{ t("common.create") }}')
    expect(source).not.toContain('{{ t("chat.newChat") }}\n            </NButton>')
  })
})
