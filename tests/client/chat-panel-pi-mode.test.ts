import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel Pi effective mode', () => {
  it('hides Global for Pi and uses the effective scoped mode for provider filtering', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('newChatAgent.value === "pi"')
    expect(source).toContain('? []')
    expect(source).toContain('return agent === "ekko-agent" || agent === "pi" ? "scoped" : requestedMode;')
    expect(source).toContain('const mode = effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value);')
    expect(source).toContain('newChatAgentMode.value = "scoped";')
  })
})
