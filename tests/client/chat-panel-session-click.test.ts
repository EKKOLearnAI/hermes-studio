import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel session clicks', () => {
  it('switches the store when the route is already on the clicked session', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('if (chatStore.activeSessionId !== sessionId)')
    expect(source).toContain('await chatStore.switchSession(sessionId)')
  })

  it('replays the whole chat surface fade without remounting the input', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('ref="chatMainContentRef" class="chat-main-content"')
    expect(source).toContain('() => chatStore.activeSessionId')
    expect(source).toContain('sessionFadeAnimation = surface.animate(')
    expect(source).toContain('sessionFadeAnimation?.cancel()')
    expect(source).not.toContain(':key="chatStore.activeSessionId" class="chat-main-content"')
  })

  it('allows session model switching for coding agent sessions', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('contextSession.value?.source === "coding_agent"')
    expect(source).toContain('isSessionModelScopedCodingAgent')
    expect(source).toContain('canScopedCodingAgentUseProvider(sessionModelCodingAgentId.value, group.provider)')
    expect(source).toContain('showSessionModelModeModal')
    expect(source).toContain('pendingSessionModelSwitch')
    expect(source).toContain('chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode)')
    expect(source).toContain('const sessionModelSwitching = ref(false)')
    expect(source).toContain('sessionModelSwitching.value = true')
    expect(source).toContain('sessionModelSwitching.value = false')
    expect(source).toContain(':show="sessionModelSwitching"')
    expect(source).toContain("t('chat.modelSwitching')")
    expect(source).toContain(':loading="sessionModelSwitching"')
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

  it('offers MoA only for Hermes session creation and switching', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('if (group.provider === "moa") return newChatAgent.value === "hermes"')
    expect(source).toContain('newChatAgent.value === "hermes" && Boolean(newChatMoaGroup.value?.models.length)')
    expect(source).toContain('group.provider === "moa"\n          ? !isSessionModelCodingAgent.value')
    expect(source).toContain('name="new-chat-model-kind"')
    expect(source).toContain('name="session-model-kind"')
    expect(source).toContain("{{ t('chat.modelType') }}")
    expect(source).toContain('<NRadioButton value="model">{{ t(\'chat.standardModels\') }}</NRadioButton>')
    expect(source).toContain('<NRadioButton value="moa">{{ t(\'chat.moaPresets\') }}</NRadioButton>')
    expect(source).toContain('await applySessionModelSwitch(preset, "moa")')
  })
})
