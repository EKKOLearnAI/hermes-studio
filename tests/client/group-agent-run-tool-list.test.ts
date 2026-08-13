// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia } from 'pinia'
import type { ChatMessage, RoomAgent } from '@/api/hermes/group-chat'
import GroupAgentRunCard from '@/components/hermes/group-chat/GroupAgentRunCard.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    }),
  }
})

const agent: RoomAgent = {
  id: 'agent-row-1',
  roomId: 'room-1',
  agentId: 'agent-1',
  profile: 'default',
  name: 'Worker',
  description: '',
  invited: 1,
}

function runItem(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'message-1',
    roomId: 'room-1',
    senderId: 'agent-1',
    senderName: 'Worker',
    content: '',
    timestamp: 1,
    role: 'assistant',
    run_id: 'run-current',
    ...overrides,
  }
}

function runMessage(items: ChatMessage[], isStreaming: boolean): ChatMessage {
  return {
    ...items[0],
    id: `group-agent-run:${items[0].senderId}:${items[0].run_id}`,
    role: 'agent_run',
    content: '',
    runItems: items,
    isStreaming,
  }
}

const GroupMessageItemStub = defineComponent({
  name: 'GroupMessageItem',
  props: {
    message: { type: Object, required: true },
  },
  template: '<div class="message-stub" :data-message-id="message.id">{{ message.toolName || message.content }}</div>',
})

function mountCard(message: ChatMessage) {
  return mount(GroupAgentRunCard, {
    props: {
      message,
      agents: [agent],
      members: [],
      currentUserId: 'user-1',
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        GroupMessageItem: GroupMessageItemStub,
        GroupAgentMessageAvatar: true,
        GroupAgentRobotIcon: true,
        ProfileAvatar: true,
      },
    },
  })
}

describe('GroupAgentRunCard tool list', () => {
  it('places only the current Agent/Run tool calls newest-first in one keyboard-focusable bounded panel', () => {
    const wrapper = mountCard(runMessage([
      runItem({ id: 'current-tool-1', role: 'tool', toolName: 'read_file', toolStatus: 'done' }),
      runItem({ id: 'current-reasoning', content: 'Checking the result.', isStreaming: true, timestamp: 2 }),
      runItem({ id: 'current-tool-2', role: 'tool', toolName: 'search', toolStatus: 'running', timestamp: 3 }),
    ], true))

    const panel = wrapper.get('.run-tool-list')
    expect(panel.attributes('tabindex')).toBe('0')
    expect(panel.attributes('aria-label')).toBe('chat.showToolCalls')
    expect(panel.attributes('data-agent-id')).toBe('agent-1')
    expect(panel.attributes('data-run-id')).toBe('run-current')
    expect(panel.findAll('.run-tool-item').map(item => item.attributes('data-message-id'))).toEqual([
      'current-tool-2',
      'current-tool-1',
    ])
    expect(wrapper.get('.run-transcript-item').attributes('data-message-id')).toBe('current-reasoning')
    expect(wrapper.get('.run-transcript').find('.tool-name').exists()).toBe(false)
    expect(wrapper.get('.run-card').element.children[0]).toBe(wrapper.get('.run-transcript').element)
    expect(wrapper.get('.run-card').element.children[1]).toBe(panel.element)
  })

  it('keeps completed historical tool calls newest-first in the same bounded panel', () => {
    const wrapper = mountCard(runMessage([
      runItem({ id: 'historical-tool-1', role: 'tool', toolName: 'read_file', toolStatus: 'done' }),
      runItem({ id: 'historical-answer', content: 'Finished.', timestamp: 2 }),
      runItem({ id: 'historical-tool-2', role: 'tool', toolName: 'search', toolStatus: 'done', timestamp: 3 }),
    ], false))

    expect(wrapper.get('.run-tool-list').findAll('.run-tool-item').map(item => item.attributes('data-message-id'))).toEqual([
      'historical-tool-2',
      'historical-tool-1',
    ])
    expect(wrapper.findAll('.run-transcript-item').map(item => item.attributes('data-message-id'))).toEqual([
      'historical-answer',
    ])
    expect(wrapper.get('.run-transcript').text()).not.toContain('read_file')
    expect(wrapper.findAll('.run-tool-item[data-message-id="historical-tool-1"]')).toHaveLength(1)
    expect(wrapper.findAll('.run-tool-item[data-message-id="historical-tool-2"]')).toHaveLength(1)
    expect(wrapper.get('.run-card').element.children[0]).toBe(wrapper.get('.run-transcript').element)
    expect(wrapper.get('.run-card').element.children[1]).toBe(wrapper.get('.run-tool-list').element)
  })
})
