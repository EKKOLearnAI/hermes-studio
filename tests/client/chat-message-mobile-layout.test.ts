// @vitest-environment jsdom
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('chat message mobile layout guards', () => {
  it('keeps chat message containers shrinkable on narrow screens', () => {
    const chatPanel = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')
    const messageList = readFileSync('packages/client/src/components/hermes/chat/MessageList.vue', 'utf8')
    const virtualList = readFileSync('packages/client/src/components/hermes/chat/VirtualMessageList.vue', 'utf8')
    const messageItem = readFileSync('packages/client/src/components/hermes/chat/MessageItem.vue', 'utf8')
    const markdownRenderer = readFileSync('packages/client/src/components/hermes/chat/MarkdownRenderer.vue', 'utf8')
    const groupChatPanel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const groupMessageList = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')
    const groupMessageItem = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')

    expect(chatPanel).toContain('.chat-panel')
    expect(chatPanel).toContain('min-width: 0;')
    expect(chatPanel).toContain('.chat-content-wrapper')
    expect(chatPanel).toContain('max-width: 100%;')

    expect(messageList).toContain('.streaming-indicator')
    expect(messageList).toContain('.tool-calls-panel')
    expect(messageList).toContain('.tool-call-preview')
    expect(messageList).toContain('function toolPreviewText')
    expect(messageList).toContain(':title="tc.toolPreview"')
    expect(messageList).toContain('max-width: 34%;')
    expect(messageList).toContain('flex: 1 1 0;')
    expect(messageList).toContain('width: 100%;')
    expect(messageList).toContain('max-width: none;')

    expect(virtualList).toContain('.virtual-message-list-host')
    expect(virtualList).toContain('.virtual-row')
    expect(virtualList).toContain('min-width: 0;')
    expect(virtualList).toContain('max-width: 100%;')

    expect(messageItem).toContain('.msg-body')
    expect(messageItem).toContain('.msg-content')
    expect(messageItem).toContain('.message-bubble')
    expect(messageItem).toContain('overflow-wrap: anywhere;')

    expect(markdownRenderer).toContain('.markdown-body')
    expect(markdownRenderer).toContain('width: 100%;')
    expect(markdownRenderer).toContain('code:not(.hljs)')
    expect(markdownRenderer).toContain('white-space: pre-wrap;')

    expect(groupChatPanel).toContain('.group-chat-panel')
    expect(groupChatPanel).toContain('min-width: 0;')
    expect(groupChatPanel).toContain('max-width: 100%;')

    expect(groupMessageList).toContain('.group-message-list')
    expect(groupMessageList).toContain('min-width: 0;')
    expect(groupMessageList).toContain('max-width: 100%;')

    expect(groupMessageItem).toContain('.group-message')
    expect(groupMessageItem).toContain('.msg-body')
    expect(groupMessageItem).toContain('.msg-content')
    expect(groupMessageItem).toContain('overflow-wrap: anywhere;')
  })
})
