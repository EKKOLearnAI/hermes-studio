// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

const mockScrollToBottom = vi.hoisted(() => vi.fn())
const mockCaptureViewportPosition = vi.hoisted(() => vi.fn())
const mockRestoreViewportPosition = vi.hoisted(() => vi.fn())

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
    emits: ['scroll', 'top-reach'],
    setup(_props, { expose }) {
      expose({
        isNearBottom: vi.fn(() => true),
        scrollToBottom: mockScrollToBottom,
        scrollToMessage: vi.fn(),
        scrollToAnchor: vi.fn(),
        captureScrollPosition: vi.fn(),
        restoreScrollPosition: vi.fn(),
        captureViewportPosition: mockCaptureViewportPosition,
        restoreViewportPosition: mockRestoreViewportPosition,
      })
    },
    template: '<div class="virtual-message-list-stub" />',
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: defineComponent({
    name: 'MessageItem',
    props: { message: { type: Object, required: true } },
    template: '<div />',
  }),
}))

import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import type { Session } from '@/stores/hermes/chat'

function makeSession(profile: string): Session {
  return {
    id: 'shared-history-session',
    profile,
    title: profile,
    messages: [{
      id: `${profile}-message`,
      role: 'user',
      content: profile,
      timestamp: Date.now(),
    }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function flushScrollState() {
  await nextTick()
  await nextTick()
}

describe('HistoryMessageList scroll position', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('keeps scroll snapshots separate when profiles reuse a session id', async () => {
    const profileASnapshot = {
      anchorMessageId: 'profile-a-message',
      anchorOffset: -18,
      scrollTop: 280,
      scrollHeight: 1100,
      clientHeight: 500,
      wasNearBottom: false,
    }
    mockCaptureViewportPosition.mockReturnValue(profileASnapshot)

    const wrapper = mount(HistoryMessageList, {
      props: {
        session: makeSession('profile-a'),
        scrollScope: 'history',
      },
    })
    await flushScrollState()
    vi.clearAllMocks()

    await wrapper.setProps({ session: makeSession('profile-b') })
    await flushScrollState()
    expect(mockCaptureViewportPosition).toHaveBeenCalled()

    mockCaptureViewportPosition.mockReturnValue({
      anchorMessageId: 'profile-b-message',
      anchorOffset: 8,
      scrollTop: 80,
      scrollHeight: 900,
      clientHeight: 500,
      wasNearBottom: false,
    })
    vi.clearAllMocks()

    await wrapper.setProps({ session: makeSession('profile-a') })
    await flushScrollState()

    expect(mockRestoreViewportPosition).toHaveBeenCalledWith(profileASnapshot)
    expect(mockScrollToBottom).not.toHaveBeenCalled()
  })
})
