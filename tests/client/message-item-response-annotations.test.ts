// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params?.count != null ? `${key}:${params.count}` : key }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import ResponseAnnotationSource from '@/components/hermes/chat/ResponseAnnotationSource.vue'
import { useChatStore, type Message } from '@/stores/hermes/chat'
import {
  createResponseAnnotationDisplayEnvelope,
  responseAnnotationSourceHash,
  type ResponseAnnotation,
} from '@/utils/chat-response-annotations'

function annotation(): ResponseAnnotation {
  return {
    id: 'sent-annotation',
    ordinal: 1,
    selectedText: 'important phrase',
    comment: 'Explain this',
    sourceMessageId: 'assistant-1',
    sourceHash: responseAnnotationSourceHash('An important phrase in this answer.'),
    start: 3,
    end: 19,
    prefix: 'An ',
    suffix: ' in this answer.',
    files: [],
  }
}

describe('MessageItem response annotation integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(), removeEventListener: vi.fn(), getVoices: vi.fn(() => []),
        speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      },
    })
  })

  it('wraps only stable assistant final-answer Markdown as an annotation source', () => {
    const stable = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-1', role: 'assistant', content: 'An **important** phrase.', timestamp: Date.now(),
        } satisfies Message,
      },
      global: {
        stubs: {
          MarkdownRenderer: { props: ['content'], template: '<div class="markdown-stub">{{ content }}</div>' },
        },
      },
    })
    expect(stable.find('.response-annotation-source').exists()).toBe(true)
    expect(stable.get('.response-annotation-source').attributes('data-message-id')).toBe('assistant-1')

    const streaming = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-2', role: 'assistant', content: 'Still streaming', timestamp: Date.now(), isStreaming: true,
        } satisfies Message,
      },
      global: {
        stubs: {
          MarkdownRenderer: { props: ['content'], template: '<div class="markdown-stub">{{ content }}</div>' },
        },
      },
    })
    expect(streaming.find('.response-annotation-source').exists()).toBe(false)
  })

  it('never exposes embedded reasoning-only content as an annotation source', () => {
    const reasoningOnly = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-reasoning-only', role: 'assistant', content: '<think>private reasoning</think>', timestamp: Date.now(),
        } satisfies Message,
      },
      global: { stubs: { MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' } } },
    })
    expect(reasoningOnly.find('.response-annotation-source').exists()).toBe(false)

    const withAnswer = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-reasoning-answer', role: 'assistant', content: '<think>private reasoning</think>Visible answer', timestamp: Date.now(),
        } satisfies Message,
      },
      global: { stubs: { MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' } } },
    })
    expect(withAnswer.getComponent(ResponseAnnotationSource).props('source')).toBe('Visible answer')
  })

  it('renders a sent envelope as ordinary body plus immutable annotation evidence', async () => {
    const envelope = createResponseAnnotationDisplayEnvelope('Follow up please', [annotation()])
    const wrapper = mount(MessageItem, {
      props: {
        message: { id: 'user-2', role: 'user', content: envelope, timestamp: Date.now() } satisfies Message,
      },
      global: {
        stubs: {
          MarkdownRenderer: { props: ['content'], template: '<div class="markdown-stub">{{ content }}</div>' },
        },
      },
    })
    await vi.dynamicImportSettled()
    await flushPromises()

    expect(wrapper.text()).toContain('Follow up please')
    expect(wrapper.text()).not.toContain('__hermes_studio_response_annotations__')
    expect(wrapper.find('[data-testid="response-annotation-count"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="response-annotation-count"]').text()).toContain('1')
  })
})
