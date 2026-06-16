// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'chat.conversationNavigatorTurn') return `Turn ${params?.index}: ${params?.title}`
      if (key === 'chat.conversationNavigatorLabel') return 'Conversation navigation'
      if (key === 'chat.conversationNavigatorUntitledTurn') return 'Untitled message'
      if (key === 'chat.emptyState') return 'Start a conversation'
      return key
    },
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true } }),
}))

import ConversationNavigator, {
  type ConversationNavItem,
} from '@/components/hermes/chat/ConversationNavigator.vue'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

const items: ConversationNavItem[] = [
  { id: 'turn-u1', messageId: 'u1', index: 1, label: 'Turn 1: First prompt' },
  { id: 'turn-u2', messageId: 'u2', index: 2, label: 'Turn 2: Second prompt' },
  { id: 'turn-u3', messageId: 'u3', index: 3, label: 'Turn 3: Third prompt' },
]

const MessageItemStub = defineComponent({
  name: 'MessageItem',
  props: {
    message: { type: Object, required: true },
    highlight: { type: Boolean, default: false },
  },
  template: '<div class="stub-message" :id="`message-${message.id}`" :data-role="message.role">{{ message.content }}</div>',
})

function makeMessage(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: Date.now() }
}

function makeSession(messages: Message[]): Session {
  return {
    id: 'session-1',
    title: 'Long chat',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('ConversationNavigator', () => {
  it('renders one accessible button per navigation item', () => {
    const wrapper = mount(ConversationNavigator, {
      props: {
        items,
        activeId: 'turn-u2',
        label: 'Conversation navigation',
      },
    })

    expect(wrapper.get('[data-testid="conversation-navigator"]').attributes('aria-label')).toBe('Conversation navigation')
    const buttons = wrapper.findAll('button.conversation-nav-dot')
    expect(buttons).toHaveLength(3)
    expect(buttons.map(button => button.attributes('aria-label'))).toEqual([
      'Turn 1: First prompt',
      'Turn 2: Second prompt',
      'Turn 3: Third prompt',
    ])
    expect(buttons[1].classes()).toContain('active')
    expect(buttons[1].attributes('aria-current')).toBe('true')
    expect(buttons[1].attributes('title')).toBeUndefined()
    expect(buttons[0].attributes('aria-current')).toBeUndefined()
    expect(wrapper.find('.conversation-nav-tooltip').exists()).toBe(false)
  })

  it('shows an immediate custom tooltip for the hovered item', async () => {
    const wrapper = mount(ConversationNavigator, {
      attachTo: document.body,
      props: {
        items,
        activeId: 'turn-u2',
        label: 'Conversation navigation',
      },
    })

    const button = wrapper.findAll('button.conversation-nav-dot')[1]
    await button.trigger('mouseenter')

    const tooltip = wrapper.get('.conversation-nav-tooltip')
    expect(tooltip.text()).toBe('Turn 2: Second prompt')
    expect(tooltip.attributes('role')).toBe('tooltip')
    wrapper.unmount()
  })

  it('emits the target message id when a bar is clicked', async () => {
    const wrapper = mount(ConversationNavigator, {
      props: {
        items,
        activeId: 'turn-u1',
        label: 'Conversation navigation',
      },
    })

    await wrapper.findAll('button.conversation-nav-dot')[2].trigger('click')

    expect(wrapper.emitted('navigate')).toEqual([['u3']])
  })

  it('renders nothing when no items are provided', () => {
    const wrapper = mount(ConversationNavigator, {
      props: {
        items: [],
        activeId: null,
        label: 'Conversation navigation',
      },
    })

    expect(wrapper.find('[data-testid="conversation-navigator"]').exists()).toBe(false)
  })
})

describe('MessageList conversation navigator integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows navigator for long chats and derives anchors from user turns only', () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession([
      makeMessage('u1', 'user', 'First prompt'),
      makeMessage('a1', 'assistant', 'First answer'),
      makeMessage('tool-1', 'tool', ''),
      makeMessage('u2', 'user', 'Second prompt'),
      makeMessage('a2', 'assistant', 'Second answer'),
      makeMessage('u3', 'user', 'Third prompt'),
      makeMessage('u4', 'user', 'Fourth prompt'),
    ])

    const wrapper = mount(MessageList, {
      global: {
        stubs: {
          MessageItem: MessageItemStub,
          Transition: false,
        },
      },
    })

    const buttons = wrapper.findAll('button.conversation-nav-dot')
    expect(buttons).toHaveLength(4)
    expect(buttons.map(button => button.attributes('aria-label'))).toEqual([
      'Turn 1: First prompt',
      'Turn 2: Second prompt',
      'Turn 3: Third prompt',
      'Turn 4: Fourth prompt',
    ])
  })

  it('hides navigator for short chats', () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession([
      makeMessage('u1', 'user', 'First prompt'),
      makeMessage('u2', 'user', 'Second prompt'),
      makeMessage('u3', 'user', 'Third prompt'),
    ])

    const wrapper = mount(MessageList, {
      global: {
        stubs: {
          MessageItem: MessageItemStub,
          Transition: false,
        },
      },
    })

    expect(wrapper.find('[data-testid="conversation-navigator"]').exists()).toBe(false)
  })

  it('keeps navigator click smooth even when the system prefers reduced motion', async () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession([
      makeMessage('u1', 'user', 'First prompt'),
      makeMessage('u2', 'user', 'Second prompt'),
      makeMessage('u3', 'user', 'Third prompt'),
      makeMessage('u4', 'user', 'Fourth prompt'),
    ])

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion: reduce'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
      if (typeof options === 'object' && typeof options.top === 'number') this.scrollTop = options.top
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })

    const wrapper = mount(MessageList, {
      attachTo: document.body,
      global: {
        stubs: {
          MessageItem: MessageItemStub,
          Transition: false,
        },
      },
    })

    wrapper.getComponent(ConversationNavigator).vm.$emit('navigate', 'u3')
    await wrapper.vm.$nextTick()

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
    const buttons = wrapper.findAll('button.conversation-nav-dot')
    expect(buttons[2].classes()).toContain('active')
    expect(buttons[2].attributes('aria-current')).toBe('true')
    wrapper.unmount()
  })
})
