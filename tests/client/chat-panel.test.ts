// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockChatStore = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>,
  activeSessionId: null as string | null,
  activeSession: null as Record<string, any> | null,
  isLoadingSessions: false,
  isSessionLive: vi.fn((sessionId: string) => sessionId === 'discord-active'),
  newChat: vi.fn(),
  switchSession: vi.fn(),
  deleteSession: vi.fn(),
}))

const mockPrefsStore = vi.hoisted(() => ({
  pinnedIds: [] as string[],
  humanOnly: true,
  isPinned: vi.fn(() => false),
  togglePinned: vi.fn(),
  setHumanOnly: vi.fn(),
  pruneMissingSessions: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => mockChatStore,
}))

vi.mock('@/stores/hermes/session-browser-prefs', () => ({
  useSessionBrowserPrefsStore: () => mockPrefsStore,
}))

vi.mock('@/api/hermes/sessions', () => ({
  renameSession: vi.fn(),
}))

vi.mock('@/components/hermes/chat/MessageList.vue', () => ({
  default: {
    template: '<div class="message-list-mock" />',
  },
}))

vi.mock('@/components/hermes/chat/ChatInput.vue', () => ({
  default: {
    template: '<div class="chat-input-mock" />',
  },
}))

vi.mock('@/components/hermes/chat/ConversationMonitorPane.vue', () => ({
  default: {
    template: '<div class="conversation-monitor-mock" />',
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
  }
})

import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'

function makeSession(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    title: id,
    source: 'api_server',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    model: 'gpt-4o',
    ...overrides,
  }
}

describe('ChatPanel session list', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()

    const activeDiscord = makeSession('discord-active', {
      title: 'Discord Active',
      source: 'discord',
      createdAt: 100,
      updatedAt: 500,
    })
    const olderDiscord = makeSession('discord-older', {
      title: 'Discord Older',
      source: 'discord',
      createdAt: 200,
      updatedAt: 400,
    })
    const slackSession = makeSession('slack-1', {
      title: 'Slack Selected',
      source: 'slack',
      createdAt: 50,
      updatedAt: 50,
    })
    const apiSession = makeSession('api-1', {
      title: 'API Session',
      source: 'api_server',
      createdAt: 300,
      updatedAt: 300,
    })

    mockChatStore.sessions = [apiSession, slackSession, olderDiscord, activeDiscord]
    mockChatStore.activeSessionId = apiSession.id
    mockChatStore.activeSession = apiSession
    mockChatStore.isLoadingSessions = false
    mockChatStore.isSessionLive.mockImplementation((sessionId: string) => sessionId === activeDiscord.id)
    mockChatStore.switchSession.mockImplementation((sessionId: string) => {
      mockChatStore.activeSessionId = sessionId
      mockChatStore.activeSession = mockChatStore.sessions.find(s => s.id === sessionId) ?? null
    })
  })

  it('pins the live session group to the top and keeps the indicator on the runtime live session', async () => {
    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          ChatInput: true,
          MessageList: true,
          NButton: true,
          NDropdown: true,
          NInput: true,
          NModal: true,
          NPopconfirm: true,
          NTooltip: true,
        },
      },
    })

    const groupLabels = wrapper.findAll('.session-group-label').map(node => node.text())
    expect(groupLabels[0]).toBe('Discord')

    const sessionTitles = wrapper.findAll('.session-item-title').map(node => node.text())
    expect(sessionTitles.slice(0, 2)).toEqual(['Discord Active', 'Discord Older'])

    const liveRow = wrapper.findAll('.session-item').find(node => node.text().includes('Discord Active'))
    expect(liveRow?.find('.session-item-active-indicator').exists()).toBe(true)
    expect(liveRow?.text()).toContain('chat.liveMode')

    const idleRow = wrapper.findAll('.session-item').find(node => node.text().includes('Discord Older'))
    expect(idleRow?.text()).not.toContain('chat.liveMode')

    await wrapper.findAll('.session-item').find(node => node.text().includes('Slack Selected'))!.trigger('click')

    expect(mockChatStore.switchSession).toHaveBeenCalledWith('slack-1')

    const groupLabelsAfterClick = wrapper.findAll('.session-group-label').map(node => node.text())
    expect(groupLabelsAfterClick[0]).toBe('Discord')
  })
})
