// @vitest-environment jsdom
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { SubagentStream } from '@/stores/hermes/chat'
import SubagentStreamPanel from '@/components/hermes/chat/SubagentStreamPanel.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

const MessageItemStub = defineComponent({
  props: ['message'],
  template: '<div class="rendered-message" :data-role="message.role" :data-reasoning="message.reasoning">{{ message.content || message.toolName }}</div>',
})

const MarkdownRendererStub = defineComponent({
  props: ['content'],
  template: '<div class="markdown-renderer-stub">{{ content }}</div>',
})

const VirtualMessageListStub = defineComponent({
  props: ['messages'],
  setup(_props, { expose }) {
    expose({
      shouldAutoFollowBottom: () => true,
      scrollToBottom: vi.fn(),
    })
  },
  template: `
    <div class="virtual-message-list">
      <template v-if="messages.length">
        <div v-for="message in messages" :key="message.id">
          <slot name="item" :message="message" />
        </div>
      </template>
      <slot v-else name="empty" />
    </div>
  `,
})

function streamFixture(): SubagentStream {
  return {
    sessionId: 'session-1',
    subagentId: 'child-1',
    taskIndex: 0,
    taskCount: 1,
    goal: 'Review shutdown behavior',
    status: 'completed',
    startedAt: 1,
    updatedAt: 4,
    entries: [
      { id: 'start', kind: 'status', status: 'started', timestamp: 1 },
      { id: 'text', kind: 'text', text: 'The worker exits safely.', timestamp: 2 },
      { id: 'tool', kind: 'tool', toolName: 'read_file', timestamp: 3 },
      { id: 'complete', kind: 'status', status: 'completed', timestamp: 4 },
    ],
  }
}

describe('SubagentStreamPanel', () => {
  it('uses the chat message renderer but keeps lifecycle status out of the transcript', () => {
    const wrapper = mount(SubagentStreamPanel, {
      props: { stream: streamFixture() },
      global: {
        stubs: {
          MessageItem: MessageItemStub,
          MarkdownRenderer: MarkdownRendererStub,
          VirtualMessageList: VirtualMessageListStub,
        },
      },
    })

    const messages = wrapper.findAll('.rendered-message')
    expect(messages).toHaveLength(2)
    expect(messages.map(message => message.attributes('data-role'))).toEqual(['assistant', 'tool'])
    expect(wrapper.find('.virtual-message-list').text()).not.toContain('subagent.completed')
    expect(wrapper.find('.subagent-status').text()).toBe('subagent.completed')
  })

  it('shows one frozen live reasoning segment with the thinking animation and restores final ownership', async () => {
    const running: SubagentStream = {
      sessionId: 'session-1',
      subagentId: 'child-1',
      taskIndex: 0,
      taskCount: 1,
      goal: 'Review shutdown behavior',
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      entries: [
        { id: 'thinking-0', kind: 'thinking', text: 'Inspect the worker.', timestamp: 1 },
        {
          id: 'tool-1',
          kind: 'tool',
          toolName: 'read_file',
          reasoning: 'Inspect the worker.',
          reasoningEntryId: 'thinking-0',
          timestamp: 2,
        },
        { id: 'thinking-1', kind: 'thinking', text: 'Draft the update.', timestamp: 3 },
        {
          id: 'text-1',
          kind: 'text',
          text: 'I found the worker.',
          reasoning: 'Draft the update.',
          reasoningEntryId: 'thinking-1',
          timestamp: 4,
        },
        { id: 'thinking-2', kind: 'thinking', text: 'Summarize the result.', timestamp: 5 },
        {
          id: 'text-2',
          kind: 'text',
          text: 'The worker exits safely.',
          reasoning: 'Summarize the result.',
          reasoningEntryId: 'thinking-2',
          timestamp: 6,
        },
      ],
    }
    const wrapper = mount(SubagentStreamPanel, {
      props: { stream: running },
      global: {
        stubs: {
          MessageItem: MessageItemStub,
          MarkdownRenderer: MarkdownRendererStub,
          VirtualMessageList: VirtualMessageListStub,
        },
      },
    })

    expect(wrapper.find('.subagent-run-indicator .thinking-avatar').exists()).toBe(true)
    expect(wrapper.get('.subagent-run-indicator .live-reasoning-detail').text()).toContain('Summarize the result.')
    expect(wrapper.get('.subagent-run-indicator .live-reasoning-detail').text()).not.toContain('Inspect the worker.')
    expect(wrapper.get('.subagent-live-tool').text()).toContain('read_file')
    const runningMessages = wrapper.findAll('.rendered-message')
    expect(runningMessages.map(message => message.text())).toEqual([
      'I found the worker.',
      'The worker exits safely.',
    ])
    expect(runningMessages.every(message => message.attributes('data-reasoning') === undefined)).toBe(true)
    expect(wrapper.find('[data-role="assistant"]:empty').exists()).toBe(false)

    await wrapper.setProps({
      stream: {
        ...running,
        status: 'completed',
        completedAt: Date.now(),
      },
    })
    await nextTick()

    expect(wrapper.find('.subagent-run-indicator').exists()).toBe(false)
    const messages = wrapper.findAll('.rendered-message')
    expect(messages.map(message => message.attributes('data-role'))).toEqual(['tool', 'assistant', 'assistant'])
    expect(messages[0].attributes('data-reasoning')).toBe('Inspect the worker.')
    expect(messages[1].attributes('data-reasoning')).toBe('Draft the update.')
    expect(messages[2].attributes('data-reasoning')).toBe('Summarize the result.')
  })

  it('never creates an assistant bubble for a reasoning-only subagent with no reply', async () => {
    const running: SubagentStream = {
      sessionId: 'session-1',
      subagentId: 'child-reasoning-only',
      taskIndex: 0,
      taskCount: 1,
      goal: 'Think without a reply',
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      entries: [
        {
          id: 'thinking-only',
          kind: 'thinking',
          text: 'I am still working through this.',
          timestamp: 1,
        },
      ],
    }
    const wrapper = mount(SubagentStreamPanel, {
      props: { stream: running },
      global: {
        stubs: {
          MessageItem: MessageItemStub,
          MarkdownRenderer: MarkdownRendererStub,
          VirtualMessageList: VirtualMessageListStub,
        },
      },
    })

    expect(wrapper.findAll('.rendered-message')).toHaveLength(0)
    expect(wrapper.get('.live-reasoning-detail').text()).toContain('I am still working through this.')

    await wrapper.setProps({
      stream: {
        ...running,
        status: 'completed',
        completedAt: Date.now(),
        entries: [
          ...running.entries,
          { id: 'complete', kind: 'status', status: 'completed', timestamp: 2 },
        ],
      },
    })
    await nextTick()

    expect(wrapper.find('.subagent-run-indicator').exists()).toBe(false)
    expect(wrapper.findAll('.rendered-message')).toHaveLength(0)
    expect(wrapper.find('.thinking-block').exists()).toBe(false)
  })
})
