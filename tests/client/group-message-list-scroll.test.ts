// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'
import type { ChatMessage, RoomAgentHandoffChain } from '@/api/hermes/group-chat'

const mockScrollToBottom = vi.hoisted(() => vi.fn())
const mockCaptureScrollPosition = vi.hoisted(() => vi.fn())
const mockRestoreScrollPosition = vi.hoisted(() => vi.fn())
const mockCaptureViewportPosition = vi.hoisted(() => vi.fn())
const mockRestoreViewportPosition = vi.hoisted(() => vi.fn())
const mockIsNearBottom = vi.hoisted(() => vi.fn(() => true))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: true }),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getApiKey: vi.fn(() => 'test-token'),
  getStoredUsername: vi.fn(() => null),
}))

vi.mock('@/api/auth', () => ({
  fetchCurrentUser: vi.fn(),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: vi.fn((path: string) => `/download?path=${path}`),
}))

vi.mock('@/api/hermes/group-chat', () => ({
  connectGroupChat: vi.fn(),
  disconnectGroupChat: vi.fn(),
  getSocket: vi.fn(),
  getStoredUserId: vi.fn(() => 'user-1'),
  getStoredUserName: vi.fn(() => 'tester'),
  createRoom: vi.fn(),
  listRooms: vi.fn(),
  getRoomDetail: vi.fn(),
  joinRoomByCode: vi.fn(),
  addAgent: vi.fn(),
  listAgents: vi.fn(),
  removeAgent: vi.fn(),
  cloneRoom: vi.fn(),
  deleteRoom: vi.fn(),
  clearRoomContext: vi.fn(),
  updateInviteCode: vi.fn(),
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: {
      messages: { type: Array, default: () => [] },
      virtualized: { type: Boolean, default: true },
    },
    emits: ['scroll', 'top-reach'],
    setup(_props, { expose }) {
      expose({
        isNearBottom: mockIsNearBottom,
        scrollToBottom: mockScrollToBottom,
        captureScrollPosition: mockCaptureScrollPosition,
        restoreScrollPosition: mockRestoreScrollPosition,
        captureViewportPosition: mockCaptureViewportPosition,
        restoreViewportPosition: mockRestoreViewportPosition,
      })
    },
    template: `
      <div class="virtual-message-list-stub" @scroll="$emit('scroll')">
        <slot name="before" />
        <slot v-if="messages.length === 0" name="empty" />
        <slot name="item" v-for="message in messages" :key="message.id" :message="message" />
      </div>
    `,
  }),
}))

vi.mock('@/components/hermes/group-chat/GroupMessageItem.vue', () => ({
  default: defineComponent({
    name: 'GroupMessageItem',
    props: { message: { type: Object, required: true } },
    template: '<div class="stub-group-message" :data-id="message.id">{{ message.content }}</div>',
  }),
}))

import GroupMessageList from '@/components/hermes/group-chat/GroupMessageList.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

function makeMessage(id: string): ChatMessage {
  return {
    id,
    roomId: 'room-1',
    senderId: 'user-1',
    senderName: 'tester',
    content: id,
    timestamp: Date.now(),
    role: 'user',
  }
}

async function flushListUpdates() {
  await nextTick()
  await nextTick()
}

describe('GroupMessageList scroll behavior', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockIsNearBottom.mockReturnValue(true)
  })

  it('disables virtual scrolling for the live group transcript', async () => {
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.messages = [makeMessage('message-1')]

    const wrapper = mount(GroupMessageList)
    await flushListUpdates()

    expect(wrapper.getComponent({ name: 'VirtualMessageList' }).props('virtualized')).toBe(false)
  })

  it('shows all four agent avatars in the group-chat empty state', () => {
    const wrapper = mount(GroupMessageList)
    const avatars = wrapper.findAll('.empty-agent-avatar img')

    expect(avatars.map(avatar => avatar.attributes('alt'))).toEqual([
      'Hermes',
      'Ekko',
      'Codex',
      'Claude',
    ])
    expect(wrapper.get('.empty-state p').text()).toBe('groupChat.emptyState')
    expect(wrapper.text()).not.toContain('chat.emptyState')
  })

  it('shows the summary boundary immediately after the summarized-through message', async () => {
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.messages = [makeMessage('message-1'), makeMessage('message-2')]
    store.roomSummaryStates.set('room-1', {
      roomId: 'room-1',
      summary: 'Earlier discussion',
      summaryThroughMessageId: 'message-1',
      summaryThroughMessageTimestamp: Date.now(),
      summarizedTurnCount: 10,
      status: 'success',
      version: 1,
      updatedAt: Date.now(),
      lastError: null,
    })

    const wrapper = mount(GroupMessageList)
    await flushListUpdates()

    const firstMessage = wrapper.get('[data-group-message-id="message-1"]')
    expect(firstMessage.get('.summary-anchor-divider').text()).toBe('groupChat.summaryMessagesAbove')
    expect(firstMessage.get('.summary-anchor-divider').attributes('data-summary-anchor-message-id')).toBe('message-1')
    expect(wrapper.get('[data-group-message-id="message-2"]').find('.summary-anchor-divider').exists()).toBe(false)
  })

  it('renders handoff controls only for Room managers and emits both actions', async () => {
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.messages = [makeMessage('message-1')]
    store.handoffChains.set('chain-1', {
      chainId: 'chain-1', roomId: 'room-1', sourceMessageId: 'message-1',
      currentDepth: 4, maxDepth: 4, unlimited: false, targetAgentId: 'agent-2',
      status: 'stopped', stopReason: 'max_depth', continueUsed: false,
      createdAt: 1, updatedAt: 1, lastError: null,
    } as RoomAgentHandoffChain)

    const reader = mount(GroupMessageList, { props: { canManageHandoff: false } })
    await flushListUpdates()
    expect(reader.find('.handoff-stop-card').exists()).toBe(true)
    expect(reader.find('.handoff-stop-actions').exists()).toBe(false)
    expect(reader.text()).not.toContain('groupChat.agentHandoffContinueState')

    const onContinue = vi.fn()
    const onSettings = vi.fn()
    const manager = mount(GroupMessageList, {
      props: {
        canManageHandoff: true,
        onContinueHandoff: onContinue,
        onAdjustHandoffSettings: onSettings,
      },
    })
    await flushListUpdates()
    const actions = manager.get('.handoff-stop-actions').findAll('button')
    expect(actions).toHaveLength(2)
    await actions[0].trigger('click')
    await actions[1].trigger('click')
    expect(onContinue).toHaveBeenCalledWith('chain-1')
    expect(onSettings).toHaveBeenCalledTimes(1)

    store.handoffChains.set('chain-1', {
      ...store.handoffChains.get('chain-1')!,
      stopReason: 'continue_failed',
      attemptId: 'failed-attempt-1',
      lastError: 'Continuation target admission was rejected',
    })
    await flushListUpdates()
    expect(reader.find('.handoff-stop-card').exists()).toBe(true)
    expect(reader.find('.handoff-stop-actions').exists()).toBe(false)
    expect(manager.get('.handoff-stop-actions').findAll('button')).toHaveLength(2)
    expect(manager.get('.handoff-stop-card').text()).toContain('groupChat.agentHandoffErrorAdmissionRejected')
    expect(manager.get('.handoff-stop-card').text()).not.toContain('Continuation target admission was rejected')

    store.handoffChains.set('chain-1', {
      ...store.handoffChains.get('chain-1')!,
      lastError: ' \t ',
    })
    await flushListUpdates()
    expect(reader.find('.handoff-stop-card').exists()).toBe(false)
    expect(manager.find('.handoff-stop-card').exists()).toBe(false)

    store.handoffChains.set('chain-1', {
      ...store.handoffChains.get('chain-1')!,
      status: 'outcome_unknown',
      stopReason: 'outcome_unknown',
      continueUsed: true,
      attemptId: 'unknown-attempt-1',
      lastError: 'Remote target invocation outcome is unknown after restart',
    })
    await flushListUpdates()
    expect(manager.get('.handoff-stop-card').text()).toContain('groupChat.agentHandoffOutcomeUnknownTitle')
    expect(manager.get('.handoff-stop-card').text()).toContain('groupChat.agentHandoffOutcomeUnknownDescription')
    expect(manager.find('.handoff-stop-actions').exists()).toBe(false)
    expect(manager.get('.handoff-stop-card').text()).not.toContain('Remote target invocation outcome is unknown after restart')
  })

  it('shows a bottom jump button when the group transcript is far from the bottom', async () => {
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.messages = [makeMessage('message-1')]
    mockIsNearBottom.mockImplementation((threshold?: number) => threshold === 1000 ? false : true)

    const wrapper = mount(GroupMessageList)
    await flushListUpdates()

    const button = wrapper.get('.scroll-bottom-button')
    expect(button.attributes('aria-label')).toBe('chat.scrollToBottom')
    expect(button.find('.scroll-bottom-icon').exists()).toBe(true)

    await button.trigger('click')

    expect(mockScrollToBottom).toHaveBeenCalledWith({ frames: 4, keepAliveMs: 600 })
    expect(wrapper.find('.scroll-bottom-button').exists()).toBe(false)
  })
})
