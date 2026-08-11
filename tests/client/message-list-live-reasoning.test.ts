// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: {
      messages: { type: Array, default: () => [] },
    },
    setup(_props, { expose }) {
      expose({
        isNearBottom: () => true,
        shouldAutoFollowBottom: () => true,
        scrollToBottom: vi.fn(),
        scrollToMessage: vi.fn(),
        scrollToAnchor: vi.fn(),
        captureScrollPosition: () => null,
        restoreScrollPosition: vi.fn(),
        captureViewportPosition: () => null,
        restoreViewportPosition: vi.fn(),
      })
    },
    template: `
      <div>
        <slot name="item" v-for="message in messages" :key="message.id" :message="message" />
        <slot name="after" />
      </div>
    `,
  }),
}))

const MessageItemStub = defineComponent({
  name: 'MessageItem',
  props: {
    message: { type: Object, required: true },
  },
  template: '<div class="message-item-stub" :data-id="message.id">{{ message.reasoning || message.content }}</div>',
})

const MarkdownRendererStub = defineComponent({
  name: 'MarkdownRenderer',
  props: {
    content: { type: String, default: '' },
  },
  template: '<div class="markdown-renderer-stub">{{ content }}</div>',
})

import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function makeSession(messages: Message[]): Session {
  return {
    id: 'session-1',
    title: 'Live reasoning',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function mountMessageList(messages: Message[], runActive = true) {
  const chatStore = useChatStore()
  chatStore.activeSessionId = 'session-1'
  chatStore.activeSession = makeSession(messages)
  chatStore.abortState = runActive ? { aborting: true, synced: false } : null

  return mount(MessageList, {
    global: {
      stubs: {
        MessageItem: MessageItemStub,
        MarkdownRenderer: MarkdownRendererStub,
      },
    },
  })
}

describe('MessageList live reasoning', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('renders live reasoning between the thinking animation and tool area instead of flashing a message bubble', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        reasoning: 'Working through the answer',
        timestamp: 2,
        isStreaming: true,
      },
    ])

    expect(wrapper.find('[data-id="assistant-1"].message-item-stub').exists()).toBe(false)
    expect(wrapper.get('.thinking-status').text()).toContain('chat.thinkingInProgress')
    expect(wrapper.get('.live-reasoning-detail').text()).toContain('Working through the answer')

    const status = wrapper.get('.thinking-status').element
    const reasoning = wrapper.get('.live-reasoning-detail').element
    expect(status.compareDocumentPosition(reasoning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the safe-insert arrow for Hermes and hides it for unsupported coding agents', async () => {
    const chatStore = useChatStore()
    const session = makeSession([])
    session.source = 'cli'
    session.agent = 'hermes'
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = session
    chatStore.queuedUserMessages = new Map([['session-1', [{
      id: 'queue-1', role: 'user', content: 'Follow up', timestamp: 1, queued: true,
    }]]])
    const insertSpy = vi.spyOn(chatStore, 'insertQueuedMessage')
    const wrapper = mount(MessageList, {
      global: { stubs: { MessageItem: MessageItemStub, MarkdownRenderer: MarkdownRendererStub } },
    })

    expect(wrapper.get('.queue-insert').attributes('title')).toBe('chat.insertQueuedMessage')
    await wrapper.get('.queue-insert').trigger('click')
    expect(insertSpy).toHaveBeenCalledWith('session-1', 'queue-1')

    chatStore.activeSession = {
      ...session,
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
    }
    await nextTick()
    expect(wrapper.find('.queue-insert').exists()).toBe(false)
  })

  it('keeps the standalone thinking status before assistant output starts', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
    ])

    expect(wrapper.get('.thinking-status').text()).toContain('chat.thinkingInProgress')
  })

  it('freezes a sealed reasoning segment above its tool until the next reasoning starts', async () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Use a tool', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        reasoning: 'Need inspect the file.',
        timestamp: 2,
        isStreaming: false,
      },
      {
        id: 'tool-1',
        role: 'tool',
        content: '',
        toolName: 'read_file',
        reasoning: 'Need inspect the file.',
        toolStatus: 'done',
        timestamp: 3,
      },
    ])

    expect(wrapper.find('[data-id="assistant-1"]').exists()).toBe(false)
    expect(wrapper.get('.live-reasoning-detail').text()).toContain('Need inspect the file.')
    const reasoning = wrapper.get('.live-reasoning-detail').element
    const tool = wrapper.get('.tool-calls-panel .tool-call-item:not(.compression-item)').element
    expect(reasoning.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(useChatStore().messages.find(message => message.id === 'assistant-1')).toEqual(
      expect.objectContaining({ reasoning: 'Need inspect the file.' }),
    )

    useChatStore().messages.push({
      id: 'assistant-2',
      role: 'assistant',
      content: '',
      reasoning: 'Now summarize the tool result.',
      timestamp: 4,
      isStreaming: true,
    })
    await nextTick()

    expect(wrapper.get('.live-reasoning-detail').text()).toContain('Now summarize the tool result.')
    expect(wrapper.get('.live-reasoning-detail').text()).not.toContain('Need inspect the file.')
    expect(useChatStore().messages.find(message => message.id === 'tool-1')).toEqual(
      expect.objectContaining({ reasoning: 'Need inspect the file.' }),
    )
  })

  it('keeps a completed reasoning-only response visible when no tool owns it', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        reasoning: 'The model returned reasoning without a final body.',
        timestamp: 2,
        isStreaming: false,
      },
    ], false)

    expect(wrapper.get('[data-id="assistant-1"]').text())
      .toBe('The model returned reasoning without a final body.')
  })

  it('keeps the thinking animation through tool execution and removes the run panel when the lifecycle finishes', async () => {
    const chatStore = useChatStore()
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Use a tool', timestamp: 1 },
      {
        id: 'tool-1',
        role: 'tool',
        content: '',
        toolName: 'read_file',
        toolStatus: 'done',
        timestamp: 2,
      },
    ])

    expect(wrapper.find('.tool-calls-panel').exists()).toBe(true)
    expect(wrapper.find('.thinking-status').exists()).toBe(true)

    chatStore.abortState = null
    await nextTick()

    expect(wrapper.find('.streaming-indicator').exists()).toBe(false)
    expect(wrapper.find('.thinking-status').exists()).toBe(false)
  })
})
