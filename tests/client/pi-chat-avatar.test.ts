import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('Pi chat identity', () => {
  it('uses the active profile avatar for assistant messages', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/MessageItem.vue', 'utf8')

    expect(source).toContain('v-if="message.role === \'assistant\'"')
    expect(source).toContain(':name="assistantProfileName"')
    expect(source).toContain(':avatar="assistantProfileAvatar"')
    expect(source).not.toContain('assistantAgentLogo')
    expect(source).not.toContain('msg-agent-avatar')
  })

  it('uses the Pi logo in empty state and completion notifications', () => {
    const messageList = readFileSync('packages/client/src/components/hermes/chat/MessageList.vue', 'utf8')
    const chatStore = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')

    expect(messageList).toContain('session?.agent === "pi" ? "pi"')
    expect(messageList).toContain('logo: "/coding-agents/pi.svg"')
    expect(chatStore).toContain("if (codingAgentId === 'pi')")
    expect(chatStore).toContain("return { icon: '/coding-agents/pi.svg' }")
  })
})
