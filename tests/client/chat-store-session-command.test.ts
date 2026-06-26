// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  resumeSession: vi.fn((sessionId: string, onResumed: (data: any) => void) => {
    onResumed({ session_id: sessionId, messages: [], isWorking: false, events: [], queueLength: 0 })
    return {} as any
  }),
  sessionCommandHandlers: [] as Array<(event: any) => void>,
  peerUserMessageHandlers: [] as Array<(event: any) => void>,
  sessionTitleUpdatedHandlers: [] as Array<(event: any) => void>,
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn((handler: (event: any) => void) => {
    chatApi.peerUserMessageHandlers.push(handler)
    return vi.fn()
  }),
  onSessionCommand: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionCommandHandlers.push(handler)
    return vi.fn()
  }),
  onSessionTitleUpdated: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionTitleUpdatedHandlers.push(handler)
    return vi.fn()
  }),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/hermes/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(): Session {
  return {
    id: 'session-1',
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store session.command fanout', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    chatApi.sessionCommandHandlers = []
    chatApi.peerUserMessageHandlers = []
    chatApi.sessionTitleUpdatedHandlers = []
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    setActivePinia(createPinia())
  })

  it('attaches to a goal resume run started from another window', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    expect(chatApi.sessionCommandHandlers).toHaveLength(1)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      message: 'Goal resumed',
      started: true,
      terminal: false,
    })

    expect(store.isStreaming).toBe(true)
    expect(chatApi.registerSessionHandlers).toHaveBeenCalledWith('session-1', expect.objectContaining({
      onRunStarted: expect.any(Function),
      onSessionCommand: expect.any(Function),
    }))
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'command',
        content: 'Goal resumed',
        commandAction: 'resume',
      }),
    ])
  })

  it('does not clear the transcript for goal done commands', () => {
    const store = useChatStore()
    const session = makeSession()
    session.messages = [
      { id: 'user-1', role: 'user', content: 'keep me', timestamp: 1 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'clear',
      message: 'Goal cleared.',
      terminal: true,
    })

    expect(store.messages).toEqual([
      expect.objectContaining({ id: 'user-1', content: 'keep me' }),
      expect.objectContaining({
        role: 'command',
        content: 'Goal cleared.',
        commandAction: 'clear',
      }),
    ])
  })

  it('updates session title from the global generated-title event', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    expect(chatApi.sessionTitleUpdatedHandlers).toHaveLength(1)

    chatApi.sessionTitleUpdatedHandlers[0]({
      event: 'session.title.updated',
      session_id: 'session-1',
      title: 'Generated Title',
    })

    expect(store.sessions[0].title).toBe('Generated Title')
    expect(store.activeSession?.title).toBe('Generated Title')
  })

  it('does not show a thinking/streaming state while submitting terminal fork commands', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.messageCount = 2
    session.messages = [
      { id: 'user-1', role: 'user', content: 'Previous question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'Previous answer', timestamp: 2 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/fork')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledWith(
      expect.objectContaining({ input: '/fork', session_id: 'session-1', source: 'cli' }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.any(Object),
    )
    expect(store.isStreaming).toBe(false)
  })

  it('debounces terminal fork commands until the session.command settles', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.messageCount = 2
    session.messages = [
      { id: 'user-1', role: 'user', content: 'Previous question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'Previous answer', timestamp: 2 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/fork')
    await store.sendMessage('/fork')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(store.isStreaming).toBe(false)
    expect(store.isForkPending).toBe(true)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'fork',
      action: 'branch',
      ok: false,
      message: 'Cannot branch: no conversation messages found to copy.',
      terminal: true,
    })

    expect(store.isForkPending).toBe(false)
  })

  it('clears stale working state when terminal session commands complete', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      message: 'Goal resumed',
      started: true,
      terminal: false,
    })
    expect(store.isStreaming).toBe(true)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'done',
      message: 'Goal done.',
      terminal: true,
    })

    expect(store.isStreaming).toBe(false)
  })

  it('adds and switches to a branched child session from session.command branch events', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.resumeSession.mockImplementationOnce((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [
          { id: 1, role: 'user', content: 'Previous question', timestamp: 1 },
          { id: 2, role: 'assistant', content: 'Previous answer', timestamp: 2 },
        ],
        parentSessionId: 'session-1',
        forkPointMessageId: '2',
        parentTitle: 'session',
        parentLastMessage: 'Previous answer',
        parentLastMessageRole: 'assistant',
        messageLoadedCount: 2,
        messageTotal: 2,
        hasMoreBefore: false,
        isWorking: false,
        events: [],
        queueLength: 0,
      })
      return {} as any
    })

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'fork',
      action: 'branch',
      ok: true,
      parentSessionId: 'session-1',
      newSessionId: 'branch-1',
      newSessionTitle: 'Side path',
      branchSession: {
        id: 'branch-1',
        profile: 'default',
        source: 'cli',
        title: 'Side path',
        model: 'openai/gpt-5.4',
        provider: 'openai-codex',
        parentSessionId: 'session-1',
        forkPointMessageId: '2',
        parentTitle: 'session',
        parentLastMessage: 'Previous answer',
        parentLastMessageRole: 'assistant',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        messageCount: 2,
        workspace: '/repo',
      },
      message: 'Branched session "Side path" from session-1.',
    })
    await Promise.resolve()

    const branch = store.sessions.find((item: Session) => item.id === 'branch-1')
    expect(branch).toMatchObject({
      title: 'Side path',
      source: 'cli',
      profile: 'default',
      model: 'openai/gpt-5.4',
      provider: 'openai-codex',
      parentSessionId: 'session-1',
      forkPointMessageId: '2',
      parentTitle: 'session',
      parentLastMessage: 'Previous answer',
      parentLastMessageRole: 'assistant',
      messageCount: 2,
      workspace: '/repo',
    })
    expect(store.activeSessionId).toBe('branch-1')
    expect(chatApi.resumeSession).toHaveBeenCalledWith('branch-1', expect.any(Function), 'default', 'chat-run')

    await store.switchSession('session-1')
    expect(store.activeSessionId).toBe('session-1')
    expect(store.activeSession?.id).toBe('session-1')
    expect(store.sessions.find((item: Session) => item.id === 'session-1')?.messages.at(-1)).toMatchObject({
      role: 'command',
      commandAction: 'branch',
      content: 'Branched session "Side path" from session-1.',
    })

    await store.switchSession('branch-1')
    expect(store.activeSessionId).toBe('branch-1')
    expect(store.activeSession?.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Previous question' }),
      expect.objectContaining({ role: 'assistant', content: 'Previous answer' }),
    ])
  })
})
