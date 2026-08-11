// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  globalPendingHandler: undefined as undefined | ((event: any) => void),
  unregisterSessionHandlers: vi.fn(),
}))

const completionSoundMock = vi.hoisted(() => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn((handler: (event: any) => void) => { chatApi.globalPendingHandler = handler; return vi.fn() }),
  onApprovalRequested: vi.fn(() => vi.fn()),
  onApprovalResolved: vi.fn(() => vi.fn()),
  onClarifyRequested: vi.fn(() => vi.fn()),
  onClarifyResolved: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
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
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: completionSoundMock.primeCompletionSound,
  playCompletionSound: completionSoundMock.playCompletionSound,
}))

import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store error handling - #1644', () => {
  let handlers: any

  beforeEach(() => {
    handlers = undefined
    chatApi.globalPendingHandler = undefined
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [],
        isWorking: false,
        events: [],
      })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
  })

  it('primes approval sound on direct send when completion sound is disabled', async () => {
    const store = useChatStore()
    const settingsStore = useSettingsStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    settingsStore.display.bell_on_complete = false
    settingsStore.display.approval_bell = true

    await store.sendMessage('request approval')

    expect(completionSoundMock.primeCompletionSound).toHaveBeenCalledOnce()
  })

  it('does not prime notification sound on direct send when both sound settings are disabled', async () => {
    const store = useChatStore()
    const settingsStore = useSettingsStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    settingsStore.display.bell_on_complete = false
    settingsStore.display.approval_bell = false

    await store.sendMessage('silent request')

    expect(completionSoundMock.primeCompletionSound).not.toHaveBeenCalled()
  })

  it('tracks an approval request from an inactive session through the global socket listener', () => {
    const store = useChatStore()
    const sessionA = makeSession('session-a')
    store.sessions = [sessionA, makeSession('session-b')]
    store.activeSessionId = 'session-a'
    store.activeSession = sessionA

    chatApi.globalPendingHandler?.({
      event: 'approval.requested',
      session_id: 'session-b',
      approval_id: 'approval-b',
      command: 'pwd',
      description: 'Run command',
      choices: ['once', 'deny'],
    })

    expect(store.pendingApprovals.get('session-b')).toMatchObject({ approvalId: 'approval-b', command: 'pwd' })
    expect(store.activePendingApproval).toBeNull()
  })

  it('keeps a pending approval when the authoritative response is unresolved', () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-a'), makeSession('session-b')]
    chatApi.globalPendingHandler?.({
      event: 'approval.requested', session_id: 'session-b', approval_id: 'approval-b', choices: ['once', 'deny'],
    })

    chatApi.globalPendingHandler?.({
      event: 'approval.resolved', session_id: 'session-b', approval_id: 'approval-b', resolved: false, error: 'stale',
    })

    expect(store.pendingApprovals.get('session-b')).toMatchObject({ approvalId: 'approval-b' })
  })

  it('preserves assistant content when run.failed fires during streaming with substantial content', async () => {
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run claude')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void

    // Simulate run.started
    onEvent({ event: 'run.started', session_id: 'session-1', run_id: 'run-1' })

    // Simulate message.delta with substantial content (>100 chars)
    const longContent = 'A'.repeat(200)
    onEvent({
      event: 'message.delta',
      session_id: 'session-1',
      run_id: 'run-1',
      delta: longContent,
      output: longContent,
    })

    // At this point the assistant message should be streaming with content
    let assistantMsg = store.activeSession?.messages.find(
      (m: Message) => m.role === 'assistant',
    )
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.isStreaming).toBe(true)
    expect((assistantMsg as any)?.content).toBe(longContent)

    // Simulate run.failed (e.g., socket disconnect)
    onEvent({
      event: 'run.failed',
      session_id: 'session-1',
      run_id: 'run-1',
      error: 'Socket disconnected',
    })

    // The original assistant message should be preserved (not overwritten)
    const msgs = store.activeSession?.messages || []
    assistantMsg = msgs.find((m: Message) => m.content === longContent)
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.content).toBe(longContent)
    expect(assistantMsg?.isStreaming).toBe(false)
    expect(assistantMsg?.systemType).toBeUndefined()

    // A separate error message should be appended
    const errorMessage = msgs.find(
      (m: Message) => m.role === 'assistant' && m.systemType === 'error',
    )
    expect(errorMessage).toBeDefined()
    expect(errorMessage?.content).toBe('Error: Socket disconnected')
  })

  it('overwrites empty streaming message when run.failed fires (no substantial content)', async () => {
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run claude')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void

    // Simulate run.started
    onEvent({ event: 'run.started', session_id: 'session-1', run_id: 'run-1' })

    // Simulate message.delta with only a short content (<100 chars)
    onEvent({
      event: 'message.delta',
      session_id: 'session-1',
      run_id: 'run-1',
      delta: 'Hi',
      output: 'Hi',
    })

    // Simulate run.failed
    onEvent({
      event: 'run.failed',
      session_id: 'session-1',
      run_id: 'run-1',
      error: 'Something went wrong',
    })

    const msgs = store.activeSession?.messages || []
    const assistantMsg = msgs.find((m: Message) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.content).toBe('Error: Something went wrong')
    expect(assistantMsg?.systemType).toBe('error')
    expect(assistantMsg?.isStreaming).toBe(false)
  })

  it('appends error as separate message when streaming has finished (isStreaming false)', async () => {
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run claude')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void

    // Simulate run.started
    onEvent({ event: 'run.started', session_id: 'session-1', run_id: 'run-1' })

    // Simulate message.delta
    onEvent({
      event: 'message.delta',
      session_id: 'session-1',
      run_id: 'run-1',
      delta: 'Hello, how can I help you?',
      output: 'Hello, how can I help you?',
    })

    // Simulate run.completed (closes streaming)
    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      run_id: 'run-1',
    })

    // At this point isStreaming should be false
    const assistantMsg = store.activeSession?.messages.find(
      (m: Message) => m.role === 'assistant',
    )
    expect(assistantMsg?.isStreaming).toBe(false)

    // Now simulate run.failed (e.g., late socket error)
    onEvent({
      event: 'run.failed',
      session_id: 'session-1',
      run_id: 'run-1',
      error: 'Late socket error',
    })

    // Original message should be unchanged
    const msgs = store.activeSession?.messages || []
    const firstAssistant = msgs.find((m: Message) => m.content === 'Hello, how can I help you?')
    expect(firstAssistant).toBeDefined()
    expect(firstAssistant?.systemType).toBeUndefined()

    // Error appended as separate message
    const errorMessage = msgs.find((m: Message) => m.systemType === 'error')
    expect(errorMessage).toBeDefined()
    expect(errorMessage?.content).toBe('Error: Late socket error')
  })
})
