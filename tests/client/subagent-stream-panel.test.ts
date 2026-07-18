// @vitest-environment jsdom
import { defineComponent } from 'vue'
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
  template: '<div class="rendered-message" :data-role="message.role">{{ message.content || message.toolName }}</div>',
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
})
