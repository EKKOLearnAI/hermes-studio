// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

const mockScrollToBottom = vi.hoisted(() => vi.fn())
const mockScrollToMessage = vi.hoisted(() => vi.fn())
const mockScrollToAnchor = vi.hoisted(() => vi.fn())
const mockCaptureViewportPosition = vi.hoisted(() => vi.fn())
const mockRestoreViewportPosition = vi.hoisted(() => vi.fn())
const mockCaptureScrollPosition = vi.hoisted(() => vi.fn())
const mockRestoreScrollPosition = vi.hoisted(() => vi.fn())
const mockIsNearBottom = vi.hoisted(() => vi.fn(() => true))
const mockShouldAutoFollowBottom = vi.hoisted(() => vi.fn(() => true))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: {
      messages: { type: Array, default: () => [] },
      virtualized: { type: Boolean, default: true },
    },
    emits: ['top-reach'],
    setup(_props, { expose }) {
      expose({
        isNearBottom: mockIsNearBottom,
        scrollToBottom: mockScrollToBottom,
        scrollToMessage: mockScrollToMessage,
        scrollToAnchor: mockScrollToAnchor,
        captureScrollPosition: mockCaptureScrollPosition,
        restoreScrollPosition: mockRestoreScrollPosition,
        captureViewportPosition: mockCaptureViewportPosition,
        restoreViewportPosition: mockRestoreViewportPosition,
        shouldAutoFollowBottom: mockShouldAutoFollowBottom,
      })
    },
    template: `
      <div class="virtual-message-list-stub">
        <slot name="before" />
        <slot name="item" v-for="message in messages" :key="message.id" :message="message" />
      </div>
    `,
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: defineComponent({
    name: 'MessageItem',
    props: { message: { type: Object, required: true } },
    template: '<div class="stub-message" :data-id="message.id">{{ message.content }}</div>',
  }),
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function makeMessage(id: string): Message {
  return { id, role: 'user', content: id, timestamp: Date.now() }
}

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [makeMessage(`${id}-message`)],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function flushSessionScroll() {
  await nextTick()
  await nextTick()
}

describe('MessageList session scroll position', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockIsNearBottom.mockReturnValue(true)
    mockShouldAutoFollowBottom.mockReturnValue(true)
  })

  it('restores a previous session scroll position instead of forcing the bottom', async () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'scroll-session-a'
    chatStore.activeSession = makeSession('scroll-session-a')

    mount(MessageList, {
      global: {
        stubs: { Transition: false },
      },
    })
    await flushSessionScroll()
    vi.clearAllMocks()

    const sessionASnapshot = {
      scrollTop: 320,
      scrollHeight: 1200,
      clientHeight: 500,
      wasNearBottom: false,
    }
    mockCaptureViewportPosition.mockReturnValue(sessionASnapshot)

    chatStore.activeSessionId = 'scroll-session-b'
    chatStore.activeSession = makeSession('scroll-session-b')
    await flushSessionScroll()
    expect(mockCaptureViewportPosition).toHaveBeenCalled()

    vi.clearAllMocks()
    mockCaptureViewportPosition.mockReturnValue({
      scrollTop: 40,
      scrollHeight: 1000,
      clientHeight: 500,
      wasNearBottom: false,
    })

    chatStore.activeSessionId = 'scroll-session-a'
    chatStore.activeSession = makeSession('scroll-session-a')
    await flushSessionScroll()

    expect(mockRestoreViewportPosition).toHaveBeenCalledWith(sessionASnapshot)
    expect(mockScrollToBottom).not.toHaveBeenCalled()
  })

  it('disables virtual scrolling for the live chat transcript', async () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'plain-scroll-session'
    chatStore.activeSession = makeSession('plain-scroll-session')

    const wrapper = mount(MessageList, {
      global: {
        stubs: { Transition: false },
      },
    })
    await flushSessionScroll()

    expect(wrapper.getComponent({ name: 'VirtualMessageList' }).props('virtualized')).toBe(false)
  })

  it('shows a history link instead of loading more after the live chat message cap', async () => {
    const chatStore = useChatStore()
    const session = makeSession('history-cap-session')
    session.profile = 'default'
    session.loadedMessageCount = 300
    session.messageTotal = 450
    session.hasMoreBefore = true
    chatStore.activeSessionId = session.id
    chatStore.activeSession = session
    const loadOlderSpy = vi.spyOn(chatStore, 'loadOlderMessages')

    const wrapper = mount(MessageList, {
      global: {
        stubs: { Transition: false },
      },
    })
    await flushSessionScroll()

    const link = wrapper.get('.history-archive-link')
    expect(link.text()).toBe('chat.viewOlderInHistory')
    expect(link.attributes('href')).toBe('#/hermes/history/session/history-cap-session?profile=default')

    wrapper.getComponent({ name: 'VirtualMessageList' }).vm.$emit('top-reach')
    await nextTick()

    expect(loadOlderSpy).not.toHaveBeenCalled()
  })

  it('shows a bottom jump button when the transcript is far from the bottom', async () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'bottom-button-session'
    chatStore.activeSession = makeSession('bottom-button-session')
    mockIsNearBottom.mockImplementation((threshold?: number) => threshold === 1000 ? false : true)

    const wrapper = mount(MessageList, {
      global: {
        stubs: { Transition: false },
      },
    })
    await flushSessionScroll()

    const button = wrapper.get('.scroll-bottom-button')
    expect(button.attributes('aria-label')).toBe('chat.scrollToBottom')

    await button.trigger('click')

    expect(mockScrollToBottom).toHaveBeenCalledWith({ frames: 4, keepAliveMs: 600 })
    expect(wrapper.find('.scroll-bottom-button').exists()).toBe(false)
  })

  it('does not force the bottom while streaming after the user scrolls away', async () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'stream-session'
    chatStore.activeSession = makeSession('stream-session')
    chatStore.activeSession.messages = [
      makeMessage('user-message'),
      { id: 'assistant-message', role: 'assistant', content: 'first', timestamp: Date.now(), isStreaming: true },
    ]
    mockShouldAutoFollowBottom.mockReturnValue(false)

    mount(MessageList, {
      global: {
        stubs: { Transition: false },
      },
    })
    await flushSessionScroll()
    vi.clearAllMocks()

    chatStore.activeSession.messages[1].content = 'first second'
    await nextTick()

    expect(mockShouldAutoFollowBottom).toHaveBeenCalled()
    expect(mockScrollToBottom).not.toHaveBeenCalled()
  })

  it('uses a single non-sticky bottom scroll for streaming updates near the bottom', async () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'stream-bottom-session'
    chatStore.activeSession = makeSession('stream-bottom-session')
    chatStore.activeSession.messages = [
      makeMessage('user-message'),
      { id: 'assistant-message', role: 'assistant', content: 'first', timestamp: Date.now(), isStreaming: true },
    ]
    mockIsNearBottom.mockReturnValue(true)

    mount(MessageList, {
      global: {
        stubs: { Transition: false },
      },
    })
    await flushSessionScroll()
    vi.clearAllMocks()

    chatStore.activeSession.messages[1].content = 'first second'
    await nextTick()

    expect(mockScrollToBottom).toHaveBeenCalledWith({ frames: 1, keepAliveMs: 0 })
  })

  it('only portals approvals to the global layer while realtime voice is open', async () => {
    const chatStore = useChatStore()
    const session = makeSession('approval-layer-session')
    chatStore.activeSessionId = session.id
    chatStore.activeSession = session
    chatStore.pendingApprovals.set(session.id, {
      sessionId: session.id,
      approvalId: 'approval-layer-request',
      command: 'npm run test',
      description: 'Run tests',
      choices: ['once', 'deny'],
      allowPermanent: false,
      isMemoryWrite: false,
      requestedAt: Date.now(),
    })

    const wrapper = mount(MessageList, {
      props: { approvalPortalToBody: false },
      global: {
        stubs: { Transition: false },
      },
    })
    await nextTick()

    expect(wrapper.find('.message-float-stack .approval-float-panel').exists()).toBe(true)
    expect(document.body.querySelector('.approval-float-panel--global')).toBeNull()

    await wrapper.setProps({ approvalPortalToBody: true })
    await nextTick()

    const globalPanel = document.body.querySelector('.approval-float-panel--global')
    expect(globalPanel).not.toBeNull()
    expect(globalPanel?.parentElement).toBe(document.body)

    await wrapper.setProps({ approvalPortalToBody: false })
    await nextTick()

    expect(document.body.querySelector('.approval-float-panel--global')).toBeNull()
    expect(wrapper.find('.message-float-stack .approval-float-panel').exists()).toBe(true)
    wrapper.unmount()
  })
})
