// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'

const resumeSessionMock = vi.fn((sessionId: string, cb: (data: any) => void) => {
  cb({ session_id: sessionId, isWorking: false, queueLength: 0, messages: [] })
})

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: (...args: any[]) => resumeSessionMock(...args),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => null),
  respondToolApproval: vi.fn(),
  onPeerUserMessage: vi.fn(),
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(async () => []),
  setSessionModel: vi.fn(async () => true),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: vi.fn(() => 'research'),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(async () => undefined),
}))

function makeSession(id: string): Session {
  return {
    id,
    profile: 'research',
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function setProfile(name: string) {
  const profiles = useProfilesStore()
  profiles.activeProfileName = name
}

describe('chat store session attention state', () => {
  beforeEach(() => {
    localStorage.clear()
    resumeSessionMock.mockClear()
    setActivePinia(createPinia())
    setProfile('research')
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('defaults unknown sessions to read', () => {
    const store = useChatStore()
    expect(store.sessionAttentionState('session-1')).toBe('read')
  })

  it('marks sessions unread and read', () => {
    const store = useChatStore()
    store.markSessionUnread('session-1')
    expect(store.sessionAttentionState('session-1')).toBe('unread')
    store.markSessionRead('session-1')
    expect(store.sessionAttentionState('session-1')).toBe('read')
  })

  it('persists unread state per profile', () => {
    const store = useChatStore()
    store.markSessionUnread('session-1')

    setActivePinia(createPinia())
    setProfile('research')
    const reloadedResearch = useChatStore()
    reloadedResearch.loadSessionAttentionState()
    expect(reloadedResearch.sessionAttentionState('session-1')).toBe('unread')

    setActivePinia(createPinia())
    setProfile('personal')
    const personal = useChatStore()
    personal.loadSessionAttentionState()
    expect(personal.sessionAttentionState('session-1')).toBe('read')
  })

  it('returns approval when a pending approval exists', () => {
    const store = useChatStore()
    store.pendingApprovals.set('session-1', {
      sessionId: 'session-1',
      approvalId: 'approval-1',
      command: 'rm -rf tmp',
      description: 'dangerous',
      choices: ['once', 'deny'],
      allowPermanent: false,
      requestedAt: Date.now(),
    })
    expect(store.hasPendingApproval('session-1')).toBe(true)
    expect(store.sessionAttentionState('session-1')).toBe('approval')
  })

  it('gives approval priority over unread and working and falls back after clearing approval', () => {
    const store = useChatStore()
    store.markSessionUnread('session-1')
    store._setSessionLiveForTest('session-1', true)
    store.pendingApprovals.set('session-1', {
      sessionId: 'session-1',
      approvalId: 'approval-1',
      command: 'cmd',
      description: '',
      choices: ['once', 'deny'],
      allowPermanent: false,
      requestedAt: Date.now(),
    })

    expect(store.sessionAttentionState('session-1')).toBe('approval')
    store.pendingApprovals.delete('session-1')
    expect(store.sessionAttentionState('session-1')).toBe('working')
    store._setSessionLiveForTest('session-1', false)
    expect(store.sessionAttentionState('session-1')).toBe('unread')
    store.markSessionRead('session-1')
    expect(store.sessionAttentionState('session-1')).toBe('read')
  })

  it('marks opened unread sessions read', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    store.markSessionUnread('session-1')

    await store.switchSession('session-1')

    expect(store.sessionAttentionState('session-1')).toBe('read')
  })

  it('opening an approval session keeps approval state', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    store.markSessionUnread('session-1')
    store.pendingApprovals.set('session-1', {
      sessionId: 'session-1',
      approvalId: 'approval-1',
      command: 'cmd',
      description: '',
      choices: ['once', 'deny'],
      allowPermanent: false,
      requestedAt: Date.now(),
    })

    await store.switchSession('session-1')

    expect(store.sessionAttentionState('session-1')).toBe('approval')
  })

  it('marks non-active session agent activity unread', () => {
    const store = useChatStore()
    store.activeSessionId = 'session-active'

    store.noteAgentActivity('session-bg')

    expect(store.sessionAttentionState('session-bg')).toBe('unread')
  })

  it('keeps active visible session activity read', () => {
    const store = useChatStore()
    store.activeSessionId = 'session-active'
    store.markSessionUnread('session-active')

    store.noteAgentActivity('session-active')

    expect(store.sessionAttentionState('session-active')).toBe('read')
  })

  it('keeps active visible session activity read without repeated localStorage writes', () => {
    const store = useChatStore()
    store.activeSessionId = 'session-active'
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    store.noteAgentActivity('session-active')
    store.noteAgentActivity('session-active')

    expect(store.sessionAttentionState('session-active')).toBe('read')
    expect(setItemSpy).not.toHaveBeenCalled()
    setItemSpy.mockRestore()
  })

  it('marks active hidden-tab session activity unread', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    const store = useChatStore()
    store.activeSessionId = 'session-active'

    store.noteAgentActivity('session-active')

    expect(store.sessionAttentionState('session-active')).toBe('unread')
  })
})
