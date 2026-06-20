// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'
import type { ChatMessage } from '@/api/hermes/group-chat'

const mockScrollToBottom = vi.hoisted(() => vi.fn())
const mockCaptureScrollPosition = vi.hoisted(() => vi.fn())
const mockRestoreScrollPosition = vi.hoisted(() => vi.fn())
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
      })
    },
    template: `
      <div class="virtual-message-list-stub" @scroll="$emit('scroll')">
        <slot name="before" />
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
