// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const routeState = vi.hoisted(() => ({
  path: '/session/new',
  fullPath: '/session/new',
  name: 'hermes.chat' as any,
  params: {} as Record<string, string>,
  query: {} as Record<string, string>,
}))

const routerReplace = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const mockSetSessionModel = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))

const chatStoreMock = vi.hoisted(() => ({
  sessionProfileFilter: null as string | null,
  sessionsLoaded: true,
  activeSessionId: null as string | null,
  activeSession: null as any,
  sessions: [] as any[],
  loadSessions: vi.fn(async (_profile?: string | null, _preferredSessionId?: string | null) => [] as any[]),
  newChat: vi.fn(),
}))

const appStoreMock = vi.hoisted(() => ({
  loadModels: vi.fn(() => Promise.resolve()),
  selectedModel: 'test-model',
  selectedProvider: 'test-provider',
}))

const profilesStoreMock = vi.hoisted(() => ({
  fetchProfiles: vi.fn(() => Promise.resolve()),
  activeProfileName: 'research',
  profiles: [{ name: 'research' }],
}))

const settingsStoreMock = vi.hoisted(() => ({
  fetchSettings: vi.fn(() => Promise.resolve()),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ replace: routerReplace }),
}))

vi.mock('@/api/hermes/sessions', () => ({
  setSessionModel: mockSetSessionModel,
}))

vi.mock('@/components/hermes/chat/ChatPanel.vue', () => ({
  default: { template: '<div class="chat-panel-stub" />' },
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => settingsStoreMock,
}))

import ChatView from '../../packages/client/src/views/hermes/ChatView.vue'

describe('ChatView route initialization', () => {
  beforeEach(() => {
    routeState.path = '/session/new'
    routeState.fullPath = '/session/new'
    routeState.name = 'hermes.chat'
    routeState.params = {}
    routeState.query = {}

    routerReplace.mockClear()
    mockSetSessionModel.mockClear()
    chatStoreMock.sessionProfileFilter = null
    chatStoreMock.sessionsLoaded = true
    chatStoreMock.activeSessionId = null
    chatStoreMock.activeSession = null
    chatStoreMock.sessions = []
    chatStoreMock.loadSessions.mockClear()
    chatStoreMock.newChat.mockReset()
    appStoreMock.loadModels.mockClear()
    appStoreMock.selectedModel = 'test-model'
    appStoreMock.selectedProvider = 'test-provider'
    profilesStoreMock.fetchProfiles.mockClear()
    profilesStoreMock.activeProfileName = 'research'
    settingsStoreMock.fetchSettings.mockClear()
  })

  it('continues the most recent session from /session/new?continue=1 and canonicalizes to /session/:id', async () => {
    const existingSession = {
      id: 'existing-session-1',
      profile: 'research',
      model: 'test-model',
      provider: 'test-provider',
      title: 'Existing session',
      source: 'cli',
      messages: [],
    }
    routeState.query = { continue: '1' }
    chatStoreMock.sessions = [existingSession]
    chatStoreMock.loadSessions.mockImplementation(async (_profile?: string | null) => {
      chatStoreMock.activeSessionId = existingSession.id
      chatStoreMock.activeSession = existingSession
      return [existingSession] as any[]
    })

    mount(ChatView)
    await flushPromises()
    await flushPromises()

    expect(appStoreMock.loadModels).toHaveBeenCalledOnce()
    expect(profilesStoreMock.fetchProfiles).toHaveBeenCalledOnce()
    expect(settingsStoreMock.fetchSettings).toHaveBeenCalledOnce()
    expect(chatStoreMock.newChat).not.toHaveBeenCalled()
    expect(mockSetSessionModel).not.toHaveBeenCalled()
    expect(chatStoreMock.loadSessions).toHaveBeenCalledWith(null)
    expect(routerReplace).toHaveBeenCalledWith({
      name: 'hermes.session',
      params: { sessionId: 'existing-session-1' },
    })
  })

  it('creates a fresh session and canonicalizes /session/new to /session/:id', async () => {
    const freshSession = {
      id: 'fresh-session-1',
      profile: 'research',
      model: 'test-model',
      provider: 'test-provider',
      title: '',
      source: 'cli',
      messages: [],
    }
    chatStoreMock.newChat.mockImplementation(() => {
      chatStoreMock.activeSessionId = freshSession.id
      chatStoreMock.activeSession = freshSession
      chatStoreMock.sessions = [freshSession]
      return freshSession
    })

    mount(ChatView)
    await flushPromises()
    await flushPromises()

    expect(appStoreMock.loadModels).toHaveBeenCalledOnce()
    expect(profilesStoreMock.fetchProfiles).toHaveBeenCalledOnce()
    expect(settingsStoreMock.fetchSettings).toHaveBeenCalledOnce()
    expect(chatStoreMock.newChat).toHaveBeenCalledOnce()
    expect(mockSetSessionModel).toHaveBeenCalledWith('fresh-session-1', 'test-model', 'test-provider')
    expect(routerReplace).toHaveBeenCalledWith({
      name: 'hermes.session',
      params: { sessionId: 'fresh-session-1' },
    })
    expect(chatStoreMock.loadSessions).toHaveBeenCalledWith(null, 'fresh-session-1')
  })

  it('loads explicit session deep links without creating a fresh session', async () => {
    routeState.path = '/session/existing-session'
    routeState.fullPath = '/session/existing-session'
    routeState.name = 'hermes.session'
    routeState.params = { sessionId: 'existing-session' }

    chatStoreMock.loadSessions.mockImplementation(async (_profile?: string | null, preferredSessionId?: string | null) => {
      if (preferredSessionId) chatStoreMock.activeSessionId = preferredSessionId
      return []
    })

    mount(ChatView)
    await flushPromises()
    await flushPromises()

    expect(chatStoreMock.newChat).not.toHaveBeenCalled()
    expect(mockSetSessionModel).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()
    expect(chatStoreMock.loadSessions).toHaveBeenCalledWith(null, 'existing-session')
  })
})