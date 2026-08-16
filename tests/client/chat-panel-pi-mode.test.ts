import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel Pi effective mode', () => {
  it('offers Global for Pi and only forces the built-in Ekko runtime to scoped mode', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')
    const codingAgentsView = readFileSync('packages/client/src/views/hermes/CodingAgentsView.vue', 'utf8')

    expect(source).toContain('{ label: t("codingAgents.launchModeGlobal"), value: "global" }')
    expect(source).toContain('return agent === "ekko-agent" ? "scoped" : requestedMode;')
    expect(source).toContain('const mode = effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value);')
    expect(source).not.toContain('newChatAgent.value === "pi" && newChatAgentMode.value !== "scoped"')
    expect(codingAgentsView).toContain("{ label: t('codingAgents.launchModeGlobal'), value: 'global' }")
    expect(codingAgentsView).not.toContain("launchAgentId.value === 'pi' ? []")
  })
})
