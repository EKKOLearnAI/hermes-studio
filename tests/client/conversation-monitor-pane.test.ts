// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockConversationsApi = vi.hoisted(() => ({
  fetchConversationSummaries: vi.fn(),
  fetchConversationDetail: vi.fn(),
}))

vi.mock('@/api/hermes/conversations', () => mockConversationsApi)

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'chat.linkedSessions' && params?.count != null) return `${params.count} linked`
      return key
    },
  }),
}))

import ConversationMonitorPane from '@/components/hermes/chat/ConversationMonitorPane.vue'

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ConversationMonitorPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      {
        id: 'conv-1',
        title: 'First conversation',
        source: 'cli',
        model: 'openai/gpt-5.4',
        started_at: 10,
        ended_at: 20,
        last_active: 20,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 3,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        preview: 'preview',
        is_active: true,
        thread_session_count: 1,
      },
      {
        id: 'conv-2',
        title: 'Second conversation',
        source: 'discord',
        model: 'openai/gpt-5.4',
        started_at: 30,
        ended_at: 40,
        last_active: 40,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 3,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        preview: 'preview-2',
        is_active: false,
        thread_session_count: 2,
      },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: 'conv-1',
      visible_count: 2,
      thread_session_count: 1,
      messages: [
        { id: 1, session_id: 'conv-1', role: 'user', content: 'hello', timestamp: 11 },
        { id: 2, session_id: 'conv-1', role: 'assistant', content: 'world', timestamp: 12 },
      ],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads conversations and the first transcript using the humanOnly preference', async () => {
    const wrapper = mount(ConversationMonitorPane, {
      props: { humanOnly: true },
    })

    await flushPromises()

    expect(mockConversationsApi.fetchConversationSummaries).toHaveBeenCalledWith({ humanOnly: true })
    expect(mockConversationsApi.fetchConversationDetail).toHaveBeenCalledWith('conv-1', { humanOnly: true })
    expect(wrapper.text()).toContain('First conversation')
    expect(wrapper.text()).toContain('hello')
    expect(wrapper.text()).toContain('world')
  })

  it('ignores stale detail responses when selection changes quickly', async () => {
    const first = deferred<any>()
    const second = deferred<any>()
    mockConversationsApi.fetchConversationDetail
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const wrapper = mount(ConversationMonitorPane, {
      props: { humanOnly: true },
    })

    await flushPromises()
    expect(mockConversationsApi.fetchConversationDetail).toHaveBeenCalledWith('conv-1', { humanOnly: true })

    const sessionButtons = wrapper.findAll('.conversation-monitor__session')
    expect(sessionButtons).toHaveLength(2)
    await sessionButtons[1].trigger('click')

    expect(mockConversationsApi.fetchConversationDetail).toHaveBeenLastCalledWith('conv-2', { humanOnly: true })

    second.resolve({
      session_id: 'conv-2',
      visible_count: 1,
      thread_session_count: 2,
      messages: [
        { id: 21, session_id: 'conv-2', role: 'assistant', content: 'newer detail wins', timestamp: 41 },
      ],
    })
    await flushPromises()

    first.resolve({
      session_id: 'conv-1',
      visible_count: 1,
      thread_session_count: 1,
      messages: [
        { id: 11, session_id: 'conv-1', role: 'assistant', content: 'stale detail loses', timestamp: 12 },
      ],
    })
    await flushPromises()

    const renderedMessages = wrapper.findAll('.conversation-monitor__message-content').map(node => node.text())
    expect(renderedMessages).toEqual(['newer detail wins'])
  })

  it('clears the polling interval on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    const wrapper = mount(ConversationMonitorPane, {
      props: { humanOnly: true },
    })

    await flushPromises()
    wrapper.unmount()

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })
})
