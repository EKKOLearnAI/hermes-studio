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
        <slot v-if="messages.length === 0" name="empty" />
        <slot name="before" />
        <slot name="item" v-for="message in messages" :key="message.id" :message="message" />
      </div>
    `,
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: defineComponent({
    name: 'MessageItem',
    props: {
      message: { type: Object, required: true },
      assistantAgent: { type: Object, default: null },
      userProfileName: { type: String, default: 'default' },
      userProfileAvatar: { type: Object, default: null },
    },
    template: '<div class="stub-message" :data-id="message.id">{{ message.content }}</div>',
  }),
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'

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
      anchorMessageId: 'scroll-session-a-message',
      anchorOffset: -24,
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
      anchorMessageId: 'scroll-session-b-message',
      anchorOffset: 12,
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

  it.each([
    {
      runtime: 'Hermes',
      session: { source: 'global_agent', agent: 'hermes' },
      logo: '/coding-agents/hermes.png',
      alt: 'Hermes',
    },
    {
      runtime: 'Ekko',
      session: { source: 'global_agent', agent: 'ekko-agent', codingAgentId: 'ekko-agent' },
      logo: '/coding-agents/ekko-agent.png',
      alt: 'Ekko',
    },
  ])('renders the $runtime logo for an empty Global Agent session', async ({ session, logo, alt }) => {
    const chatStore = useChatStore()
    const activeSession = { ...makeSession(`empty-${alt}`), ...session, messages: [] } as Session
    chatStore.activeSessionId = activeSession.id
    chatStore.activeSession = activeSession

    const wrapper = mount(MessageList, {
      global: {
        stubs: { Transition: false },
      },
    })
    await flushSessionScroll()

    const emptyLogo = wrapper.get('.empty-logo')
    expect(emptyLogo.attributes('src')).toBe(logo)
    expect(emptyLogo.attributes('alt')).toBe(alt)
  })

  it.each([
    ['Hermes', { agent: 'hermes' }, '/coding-agents/hermes.png'],
    ['Ekko', { agent: 'ekko-agent', codingAgentId: 'ekko-agent' }, '/coding-agents/ekko-agent.png'],
    ['Claude', { source: 'coding_agent', agent: 'claude', codingAgentId: 'claude-code' }, '/coding-agents/claude-code.svg'],
    ['Codex', { source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' }, '/coding-agents/codex-openai.png'],
    ['Pi', { source: 'coding_agent', agent: 'pi', codingAgentId: 'pi' }, '/coding-agents/pi.svg'],
    ['Grok', { source: 'coding_agent', agent: 'grok', codingAgentId: 'grok' }, '/coding-agents/grok.svg'],
  ])('passes the $runtime avatar to Assistant message bubbles', async (label, identity, src) => {
    const chatStore = useChatStore()
    const activeSession = { ...makeSession(`avatar-${label}`), ...identity } as Session
    activeSession.messages = [{
      id: `assistant-${label}`,
      role: 'assistant',
      content: label,
      timestamp: Date.now(),
    }]
    chatStore.activeSessionId = activeSession.id
    chatStore.activeSession = activeSession

    const wrapper = mount(MessageList, {
      global: { stubs: { Transition: false } },
    })
    await flushSessionScroll()

    expect(wrapper.getComponent({ name: 'MessageItem' }).props('assistantAgent')).toEqual({ label, src })
  })

  it('passes the active session profile identity to user message bubbles', async () => {
    const chatStore = useChatStore()
    const profilesStore = useProfilesStore()
    const avatar = { type: 'generated' as const, seed: 'research-avatar' }
    profilesStore.activeProfileName = 'default'
    profilesStore.profiles = [
      { name: 'default', active: true, model: '', alias: '' },
      { name: 'research', active: false, model: '', alias: 'Researcher', avatar },
    ]

    const session = makeSession('profile-identity-session')
    session.profile = 'research'
    chatStore.activeSessionId = session.id
    chatStore.activeSession = session

    const wrapper = mount(MessageList, {
      global: { stubs: { Transition: false } },
    })
    await flushSessionScroll()

    const messageItem = wrapper.getComponent({ name: 'MessageItem' })
    expect(messageItem.props('userProfileName')).toBe('Researcher')
    expect(messageItem.props('userProfileAvatar')).toEqual(avatar)
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

  it('has no close control and keeps explicit approval and reply actions usable', async () => {
    const chatStore = useChatStore()
    const session = makeSession('stale-prompt-session')
    chatStore.activeSessionId = session.id
    chatStore.activeSession = session
    chatStore.pendingApprovals.set(session.id, {
      sessionId: session.id,
      approvalId: 'stale-approval',
      command: 'npm run test',
      description: 'Run tests',
      choices: ['once', 'deny'],
      allowPermanent: false,
      isMemoryWrite: false,
      requestedAt: Date.now() - 10,
    })
    chatStore.pendingClarifies.set(session.id, {
      sessionId: session.id,
      clarifyId: 'stale-clarify',
      question: 'Which environment?',
      choices: ['staging'],
      initialResponse: '',
      responseMode: 'input',
      timeoutMs: 1,
      requestedAt: Date.now() - 10,
    })

    const wrapper = mount(MessageList, {
      global: { stubs: { Transition: false } },
    })
    await nextTick()

    expect(wrapper.find('.float-panel-close').exists()).toBe(false)
    const approvalPanel = wrapper.findAll('.approval-float-panel')
      .find(panel => panel.text().includes('chat.approvalTitle'))
    expect(approvalPanel).toBeTruthy()
    await approvalPanel!.get('.approval-float-actions button').trigger('click')
    expect(chatStore.pendingApprovals.has(session.id)).toBe(false)
    expect(chatStore.pendingClarifies.has(session.id)).toBe(true)

    await nextTick()
    const clarifyPanel = wrapper.findAll('.approval-float-panel')
      .find(panel => panel.text().includes('chat.clarifyTitle'))
    expect(clarifyPanel).toBeTruthy()
    await clarifyPanel!.get('.approval-float-actions button').trigger('click')
    expect(chatStore.pendingClarifies.has(session.id)).toBe(false)
    wrapper.unmount()
  })
})
