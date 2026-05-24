// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'

const statusMock = vi.hoisted(() => ({
  handlers: null as null | { onSnapshot: (payload: any) => void; onUpdate: (status: any) => void; onSessionListChanged?: (payload: any) => void },
  handlersByProfile: {} as Record<string, { onSnapshot: (payload: any) => void; onUpdate: (status: any) => void; onSessionListChanged?: (payload: any) => void }>,
  stopsByProfile: {} as Record<string, ReturnType<typeof vi.fn>>,
}))

const sessionsApiMock = vi.hoisted(() => ({
  fetchSessions: vi.fn(async () => [] as any[]),
}))

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
  subscribeSessionStatus: vi.fn((profile: string, handlers: any) => {
    statusMock.handlers = handlers
    statusMock.handlersByProfile[profile] = handlers
    const stop = vi.fn(() => {
      if (statusMock.handlers === handlers) statusMock.handlers = null
      delete statusMock.handlersByProfile[profile]
    })
    statusMock.stopsByProfile[profile] = stop
    return stop
  }),
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: sessionsApiMock.fetchSessions,
  setSessionModel: vi.fn(async () => true),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: vi.fn(() => 'research'),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(async () => undefined),
}))

function makeSession(id: string, profile = 'research'): Session {
  return {
    id,
    profile,
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
    statusMock.handlers = null
    statusMock.handlersByProfile = {}
    statusMock.stopsByProfile = {}
    sessionsApiMock.fetchSessions.mockReset()
    sessionsApiMock.fetchSessions.mockResolvedValue([])
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

  it('reloads read state from external browser sync events', () => {
    const store = useChatStore()
    store.markSessionUnread('session-1')
    expect(store.sessionAttentionState('session-1')).toBe('unread')

    localStorage.setItem('hermes_session_attention_v1_research', JSON.stringify({
      unread: [],
      seenAt: { 'session-1': Date.now() },
    }))
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'hermes.browserSync.hermes-ui',
      newValue: JSON.stringify({
        event: { type: 'session-attention.changed', profile: 'research', sourceId: 'external-tab' },
        at: Date.now(),
      }),
    }))

    expect(store.sessionAttentionState('session-1')).toBe('read')
  })

  it('uses runtime status feed for working and approval attention states', () => {
    const store = useChatStore()
    store.startSessionStatusSync('research')

    statusMock.handlersByProfile.research?.onSnapshot({
      profile: 'research',
      sessions: [{ session_id: 'session-1', profile: 'research', isWorking: true, updatedAt: Date.now() }],
    })
    expect(store.sessionAttentionState('session-1')).toBe('working')

    statusMock.handlersByProfile.research?.onUpdate({
      session_id: 'session-1',
      profile: 'research',
      isWorking: true,
      pendingApproval: {
        approval_id: 'approval-1',
        command: 'touch file',
        description: 'Need permission',
        choices: ['once', 'deny'],
        allow_permanent: false,
        requested_at: 123,
      },
      updatedAt: Date.now(),
    })
    expect(store.sessionAttentionState('session-1')).toBe('approval')

    statusMock.handlersByProfile.research?.onUpdate({
      session_id: 'session-1',
      profile: 'research',
      isWorking: false,
      pendingApproval: null,
      updatedAt: Date.now(),
    })
    expect(store.sessionAttentionState('session-1')).toBe('read')
  })

  it('shows runtime status for a non-active profile session', () => {
    const store = useChatStore()
    store.sessions = [makeSession('other-session', 'personal')]
    store.startSessionStatusSync('research')

    expect(statusMock.handlersByProfile.research).toBeTruthy()
    expect(statusMock.handlersByProfile.personal).toBeTruthy()

    statusMock.handlersByProfile.personal?.onUpdate({
      session_id: 'other-session',
      profile: 'personal',
      isWorking: true,
      updatedAt: Date.now(),
    })

    expect(store.sessionAttentionState('other-session')).toBe('working')
  })

  it('subscribes to active and loaded session profiles after loading sessions', async () => {
    const now = Math.floor(Date.now() / 1000)
    sessionsApiMock.fetchSessions.mockResolvedValue([
      { id: 'session-research', profile: 'research', title: 'Research', started_at: now, last_active: now },
      { id: 'session-personal', profile: 'personal', title: 'Personal', started_at: now, last_active: now },
    ])
    const store = useChatStore()

    await store.loadSessions('research', null, { preserveActive: true, switchIfMissing: false })

    expect(Object.keys(statusMock.handlersByProfile).sort()).toEqual(['personal', 'research'])
  })

  it('refreshes sessions without changing active session on list invalidation', async () => {
    vi.useFakeTimers()
    try {
      const now = Math.floor(Date.now() / 1000)
      const store = useChatStore()
      store.sessions = [makeSession('session-read-1')]
      store.activeSessionId = 'session-read-1'
      store.startSessionStatusSync('research')
      sessionsApiMock.fetchSessions.mockResolvedValueOnce([
        { id: 'new-session', profile: 'research', title: 'New', started_at: now, last_active: now },
        { id: 'session-read-1', profile: 'research', title: 'Existing', started_at: now, last_active: now },
      ])

      statusMock.handlersByProfile.research?.onSessionListChanged?.({
        profile: 'research',
        reason: 'created',
        session_id: 'new-session',
        updatedAt: Date.now(),
      })
      await vi.advanceTimersByTimeAsync(151)

      expect(store.activeSessionId).toBe('session-read-1')
      expect(store.sessions.some((session: Session) => session.id === 'new-session')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves all-profile list scope when one profile invalidates', async () => {
    vi.useFakeTimers()
    try {
      const now = Math.floor(Date.now() / 1000)
      const store = useChatStore()
      store.sessionProfileFilter = null
      store.sessions = [
        makeSession('session-research', 'research'),
        makeSession('session-personal', 'personal'),
      ]
      store.activeSessionId = 'session-research'
      store.startSessionStatusSync('research')
      sessionsApiMock.fetchSessions.mockResolvedValueOnce([
        { id: 'session-research', profile: 'research', title: 'Research', started_at: now, last_active: now },
        { id: 'session-personal', profile: 'personal', title: 'Personal', started_at: now, last_active: now },
        { id: 'session-personal-new', profile: 'personal', title: 'Personal New', started_at: now, last_active: now },
      ])

      statusMock.handlersByProfile.personal?.onSessionListChanged?.({
        profile: 'personal',
        reason: 'created',
        session_id: 'session-personal-new',
        updatedAt: Date.now(),
      })
      await vi.advanceTimersByTimeAsync(151)

      expect(sessionsApiMock.fetchSessions).toHaveBeenLastCalledWith(undefined, undefined, undefined)
      expect(store.sessions.map((session: Session) => session.id).sort()).toEqual([
        'session-personal',
        'session-personal-new',
        'session-research',
      ])
      expect(store.activeSessionId).toBe('session-research')
    } finally {
      vi.useRealTimers()
    }
  })
})
