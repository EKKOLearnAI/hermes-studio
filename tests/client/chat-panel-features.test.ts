// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mockChatStore = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>,
  activeSessionId: null as string | null,
  activeSession: null as Record<string, any> | null,
  isLoadingSessions: false,
  sessionsLoaded: true,
  isSessionLive: vi.fn((sessionId: string) => sessionId === 'discord-active'),
  newChat: vi.fn(),
  switchSession: vi.fn(),
  deleteSession: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => mockChatStore,
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
    props: ['humanOnly'],
    template: '<div class="conversation-monitor-mock">monitor {{ humanOnly }}</div>',
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
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'

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

const NButtonStub = {
  emits: ['click'],
  template: '<button class="n-button-stub" v-bind="$attrs" @click="$emit(\'click\')"><slot /><slot name="icon" /></button>',
}

const NDropdownStub = {
  props: ['options', 'show'],
  emits: ['select', 'clickoutside'],
  template: `
    <div v-if="show" class="dropdown-stub">
      <button
        v-for="option in options"
        :key="option.key"
        class="dropdown-option"
        @click="$emit('select', option.key)"
      >{{ option.label }}</button>
    </div>
  `,
}

describe('ChatPanel modes and pinning', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
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
    mockChatStore.sessionsLoaded = true
    mockChatStore.isSessionLive.mockImplementation((sessionId: string) => sessionId === activeDiscord.id)
    mockChatStore.switchSession.mockImplementation((sessionId: string) => {
      mockChatStore.activeSessionId = sessionId
      mockChatStore.activeSession = mockChatStore.sessions.find(s => s.id === sessionId) ?? null
    })
  })

  it('pins and unpins a session through the context menu without duplicating it', async () => {
    const prefsStore = useSessionBrowserPrefsStore()
    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          NButton: NButtonStub,
          NDropdown: NDropdownStub,
          NInput: true,
          NModal: true,
          NPopconfirm: true,
          NTooltip: true,
        },
      },
    })

    const slackRow = wrapper.findAll('.session-item').find(node => node.text().includes('Slack Selected'))
    expect(slackRow).toBeTruthy()
    await slackRow!.trigger('contextmenu')
    ;(wrapper.vm as any).handleContextMenuSelect('pin')
    await Promise.resolve()

    expect(prefsStore.pinnedIds).toEqual(['slack-1'])
    const groupLabelsAfterPin = wrapper.findAll('.session-group-label').map(node => node.text())
    expect(groupLabelsAfterPin[0]).toBe('chat.pinned')
    expect(wrapper.findAll('.session-item-title').map(node => node.text()).filter(text => text === 'Slack Selected')).toHaveLength(1)

    const pinnedRow = wrapper.findAll('.session-item').find(node => node.text().includes('Slack Selected'))
    await pinnedRow!.trigger('contextmenu')
    ;(wrapper.vm as any).handleContextMenuSelect('pin')
    await Promise.resolve()

    expect(prefsStore.pinnedIds).toEqual([])
    expect(wrapper.findAll('.session-group-label').map(node => node.text())).not.toContain('chat.pinned')
    expect(wrapper.findAll('.session-item-title').map(node => node.text()).filter(text => text === 'Slack Selected')).toHaveLength(1)
  })

  it('does not prune saved pins before sessions have completed loading or when the list is empty', () => {
    const prefsStore = useSessionBrowserPrefsStore()
    const pruneSpy = vi.spyOn(prefsStore, 'pruneMissingSessions')
    mockChatStore.sessions = []
    mockChatStore.activeSessionId = null
    mockChatStore.activeSession = null
    mockChatStore.sessionsLoaded = false

    mount(ChatPanel, {
      global: {
        stubs: {
          NButton: NButtonStub,
          NDropdown: NDropdownStub,
          NInput: true,
          NModal: true,
          NPopconfirm: true,
          NTooltip: true,
        },
      },
    })

    expect(pruneSpy).not.toHaveBeenCalled()
  })

  it('switches between live and chat mode with accessible pressed state and restores sidebar visibility', async () => {
    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          NDropdown: NDropdownStub,
          NInput: true,
          NModal: true,
          NPopconfirm: true,
          NTooltip: true,
          NButton: NButtonStub,
        },
      },
    })

    const modeButtons = wrapper.findAll('.chat-mode-toggle button')
    expect(modeButtons[0].attributes('aria-pressed')).toBe('true')
    expect(modeButtons[1].attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('.session-list').classes()).not.toContain('collapsed')

    await modeButtons[1].trigger('click')
    const liveButtons = wrapper.findAll('.chat-mode-toggle button')
    expect(liveButtons[0].attributes('aria-pressed')).toBe('false')
    expect(liveButtons[1].attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.conversation-monitor-mock').exists()).toBe(true)

    await liveButtons[0].trigger('click')
    const chatButtons = wrapper.findAll('.chat-mode-toggle button')
    expect(chatButtons[0].attributes('aria-pressed')).toBe('true')
    expect(chatButtons[1].attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('.session-list').classes()).not.toContain('collapsed')
    expect(wrapper.find('.chat-input-mock').exists()).toBe(true)
  })
})
