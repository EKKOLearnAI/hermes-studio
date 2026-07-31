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

function mountMessageList(messages: Message[]) {
  const chatStore = useChatStore()
  chatStore.activeSessionId = 'session-1'
  chatStore.activeSession = makeSession(messages)
  chatStore.abortState = { aborting: true, synced: false }

  return mount(MessageList, {
    global: {
      stubs: {
        MessageItem: MessageItemStub,
      },
    },
  })
}

describe('MessageList live reasoning', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('renders reasoning-only streaming output through the normal message item while the run indicator stays visible', () => {
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

    expect(wrapper.get('[data-id="assistant-1"]').text()).toBe('Working through the answer')
    expect(wrapper.get('.thinking-status').text()).toContain('chat.thinkingInProgress')
  })

  it('keeps the standalone thinking status before assistant output starts', () => {
    const wrapper = mountMessageList([
      { id: 'user-1', role: 'user', content: 'Think about this', timestamp: 1 },
    ])

    expect(wrapper.get('.thinking-status').text()).toContain('chat.thinkingInProgress')
  })

  it('keeps sealed tool-call reasoning in state without leaving a standalone bubble', () => {
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
        toolStatus: 'done',
        timestamp: 3,
      },
    ])

    expect(wrapper.find('[data-id="assistant-1"]').exists()).toBe(false)
    expect(useChatStore().messages.find(message => message.id === 'assistant-1')).toEqual(
      expect.objectContaining({ reasoning: 'Need inspect the file.' }),
    )
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
