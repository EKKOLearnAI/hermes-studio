// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
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
  triggerUpdate: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store compression state', () => {
  let handlers: any

  beforeEach(() => {
    handlers = undefined
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [],
        isWorking: sessionId === 'session-1',
        events: [],
      })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
  })

  it('does not show a background session compression indicator in the active session', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-1'), makeSession('session-2')]

    await store.switchSession('session-1')
    const sessionHandlers = chatApi.registerSessionHandlers.mock.calls.find(call => call[0] === 'session-1')?.[1]
    expect(sessionHandlers).toBeTruthy()

    await store.switchSession('session-2')
    sessionHandlers.onCompressionStarted({
      event: 'compression.started',
      session_id: 'session-1',
      message_count: 6,
      token_count: 1234,
    })

    expect(store.activeSessionId).toBe('session-2')
    expect(store.compressionState).toBeNull()

    await store.switchSession('session-1')
    expect(store.compressionState).toEqual(expect.objectContaining({
      compressing: true,
      messageCount: 6,
      beforeTokens: 1234,
    }))
  })

  it('surfaces non-terminal reattach warnings replayed in a non-working resume payload', async () => {
    chatApi.resumeSession.mockImplementationOnce((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [],
        isWorking: false,
        events: [{
          event: 'run.reattach_failed',
          data: {
            event: 'run.reattach_failed',
            session_id: sessionId,
            error: 'connect ECONNREFUSED configured endpoint',
            message: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
            text: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
          },
        }],
      })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession('session-reattach')]

    await store.switchSession('session-reattach')
    await nextTick()

    expect(store.activeSession?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        commandAction: 'agent.event',
        content: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
      }),
    ]))
  })

  it('preserves streamed content when run.completed parsed_content is blank', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    store.activeSession!.messages = [{
      id: 'a1',
      role: 'assistant',
      content: 'final answer',
      timestamp: Date.now(),
      isStreaming: true,
    } as any]

    handlers.onRunCompleted({ event: 'run.completed', parsed_content: '', output: '', run_id: 'run-1' })
    await nextTick()

    const assistant = store.activeSession?.messages.find((message: Message) => message.id === 'a1')
    expect(assistant?.content).toBe('final answer')
    expect(assistant?.isStreaming).toBe(false)
    expect(store.activeSession?.messages.some(
      (message: Message) => message.role === 'system' && message.content.includes('Agent returned no output'),
    )).toBe(false)
  })

  it('renders parsed_content-only completion as a new assistant message and auto-plays it', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    store.setAutoPlaySpeech(true)

    handlers.onRunCompleted({
      event: 'run.completed',
      parsed_content: 'final answer',
      output: '',
      run_id: 'run-parsed-only',
    })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    const assistantMessages = store.activeSession?.messages.filter((message: Message) => message.role === 'assistant') ?? []
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]?.content).toBe('final answer')
    expect(store.activeSession?.messages.some(
      (message: Message) => message.role === 'system' && message.content.includes('Agent returned no output'),
    )).toBe(false)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const autoPlayEvent = dispatchSpy.mock.calls[0][0] as CustomEvent<{ messageId: string; content: string }>
    expect(autoPlayEvent.type).toBe('auto-play-speech')
    expect(autoPlayEvent.detail.content).toBe('final answer')
    expect(autoPlayEvent.detail.messageId).toBe(assistantMessages[0]?.id)
    vi.useRealTimers()
  })

  it('does not treat an older assistant message as output for a blank run.completed event', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    store.setAutoPlaySpeech(true)
    store.activeSession!.messages = [{
      id: 'old-a1',
      role: 'assistant',
      content: 'previous answer',
      timestamp: Date.now(),
      isStreaming: false,
    } as any]

    handlers.onRunCompleted({ event: 'run.completed', parsed_content: '', output: '', run_id: 'run-2' })
    await nextTick()

    expect(store.activeSession?.messages.find((message: Message) => message.id === 'old-a1')?.content).toBe('previous answer')
    expect(store.activeSession?.messages.some(
      (message: Message) => message.role === 'system' && message.content.includes('Agent returned no output'),
    )).toBe(true)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('renders parsed_content-only completion as a new assistant message after reconnect resume and auto-plays it', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    store.setAutoPlaySpeech(true)

    await store.sendMessage('resume run')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    const reconnectOptions = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }

    reconnectOptions.onReconnectResume({
      session_id: 'session-1',
      isWorking: true,
      messages: [],
      events: [],
    })

    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      parsed_content: 'final answer',
      output: '',
      run_id: 'run-reconnect-parsed-only',
    })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    const assistantMessages = store.activeSession?.messages.filter((message: Message) => message.role === 'assistant') ?? []
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]?.content).toBe('final answer')
    expect(store.activeSession?.messages.some(
      (message: Message) => message.role === 'system' && message.content.includes('Agent returned no output'),
    )).toBe(false)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const autoPlayEvent = dispatchSpy.mock.calls[0][0] as CustomEvent<{ messageId: string; content: string }>
    expect(autoPlayEvent.type).toBe('auto-play-speech')
    expect(autoPlayEvent.detail.content).toBe('final answer')
    expect(autoPlayEvent.detail.messageId).toBe(assistantMessages[0]?.id)
    vi.useRealTimers()
  })

  it('renders object-shaped run failure errors with their message text', async () => {
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run claude')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    onEvent({
      event: 'run.failed',
      session_id: 'session-1',
      error: {
        message: 'spawn claude ENOENT',
        code: 'ENOENT',
      },
    })

    const errorMessage = store.activeSession?.messages.find(
      (message: Message) => message.role === 'assistant' && message.systemType === 'error',
    )
    expect(errorMessage?.content).toBe('Error: spawn claude ENOENT')
    expect(errorMessage?.content).not.toContain('[object Object]')
  })

  it('appends post-reconnect deltas to a genuine resumed in-flight assistant instead of duplicating it', async () => {
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('resume run')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    const reconnectOptions = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }

    reconnectOptions.onReconnectResume({
      session_id: 'session-1',
      isWorking: true,
      messages: [{
        id: 'current-a1',
        role: 'assistant',
        content: 'partial answer',
        timestamp: Date.now() / 1000,
        finish_reason: null,
        runMarker: 'cli_run_current',
      }],
      events: [],
    })

    onEvent({
      event: 'message.delta',
      session_id: 'session-1',
      delta: ' continued',
      run_id: 'run-reconnect-streaming',
    })
    await nextTick()

    const assistantMessages = store.activeSession?.messages.filter((message: Message) => message.role === 'assistant') ?? []
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toEqual(expect.objectContaining({
      id: 'current-a1',
      content: 'partial answer continued',
      isStreaming: true,
    }))
  })

  it('closes a genuine resumed in-flight assistant on blank completion without swallowed-error or replay', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    store.setAutoPlaySpeech(true)

    await store.sendMessage('resume run')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    const reconnectOptions = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }

    reconnectOptions.onReconnectResume({
      session_id: 'session-1',
      isWorking: true,
      messages: [{
        id: 'current-a1',
        role: 'assistant',
        content: 'partial answer',
        timestamp: Date.now() / 1000,
        finish_reason: null,
        runMarker: 'cli_run_current',
      }],
      events: [],
    })

    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      parsed_content: '',
      output: '',
      run_id: 'run-reconnect-blank-resumed-current',
    })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    const assistantMessages = store.activeSession?.messages.filter((message: Message) => message.role === 'assistant') ?? []
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toEqual(expect.objectContaining({
      id: 'current-a1',
      content: 'partial answer',
      isStreaming: false,
    }))
    expect(store.activeSession?.messages.some(
      (message: Message) => message.role === 'system' && message.content.includes('Agent returned no output'),
    )).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('finalizes a genuine resumed in-flight assistant with parsed_content instead of appending a second row', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    store.setAutoPlaySpeech(true)

    await store.sendMessage('resume run')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    const reconnectOptions = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }

    reconnectOptions.onReconnectResume({
      session_id: 'session-1',
      isWorking: true,
      messages: [{
        id: 'current-a1',
        role: 'assistant',
        content: 'partial answer',
        timestamp: Date.now() / 1000,
        finish_reason: null,
        runMarker: 'cli_run_current',
      }],
      events: [],
    })

    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      parsed_content: 'final answer',
      output: '',
      run_id: 'run-reconnect-current-parsed-content',
    })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    const assistantMessages = store.activeSession?.messages.filter((message: Message) => message.role === 'assistant') ?? []
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toEqual(expect.objectContaining({
      id: 'current-a1',
      content: 'final answer',
      isStreaming: false,
    }))
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const autoPlayEvent = dispatchSpy.mock.calls[0][0] as CustomEvent<{ messageId: string; content: string }>
    expect(autoPlayEvent.type).toBe('auto-play-speech')
    expect(autoPlayEvent.detail.content).toBe('final answer')
    expect(autoPlayEvent.detail.messageId).toBe('current-a1')
    vi.useRealTimers()
  })

  it('does not auto-play resumed assistant history again on blank completion after reconnect', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    const session = makeSession('session-1')
    session.messages = [{
      id: 'old-a1',
      role: 'assistant',
      content: 'previous answer',
      timestamp: Date.now(),
      isStreaming: false,
    } as any]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    store.setAutoPlaySpeech(true)

    await store.sendMessage('resume run')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    const reconnectOptions = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }

    reconnectOptions.onReconnectResume({
      session_id: 'session-1',
      isWorking: true,
      messages: [{
        id: 'old-a1',
        role: 'assistant',
        content: 'previous answer',
        timestamp: Date.now() / 1000,
        finish_reason: 'stop',
      }],
      events: [],
    })

    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      parsed_content: '',
      output: '',
      run_id: 'run-reconnect-blank',
    })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    expect(store.activeSession?.messages.find((message: Message) => message.id === 'old-a1')?.content).toBe('previous answer')
    expect(dispatchSpy).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('preserves resumed assistant history when parsed_content arrives after reconnect and auto-plays the new row', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    const session = makeSession('session-1')
    session.messages = [{
      id: 'old-a1',
      role: 'assistant',
      content: 'previous answer',
      timestamp: Date.now(),
      isStreaming: false,
    } as any]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    store.setAutoPlaySpeech(true)

    await store.sendMessage('resume run')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    const reconnectOptions = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }

    reconnectOptions.onReconnectResume({
      session_id: 'session-1',
      isWorking: true,
      messages: [{
        id: 'old-a1',
        role: 'assistant',
        content: 'previous answer',
        timestamp: Date.now() / 1000,
      }],
      events: [],
    })

    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      parsed_content: 'final answer',
      output: '',
      run_id: 'run-reconnect-historical-parsed-content',
    })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    const assistantMessages = store.activeSession?.messages.filter((message: Message) => message.role === 'assistant') ?? []
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[0]).toEqual(expect.objectContaining({
      id: 'old-a1',
      content: 'previous answer',
    }))
    expect(assistantMessages[1]).toEqual(expect.objectContaining({
      content: 'final answer',
    }))
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const autoPlayEvent = dispatchSpy.mock.calls[0][0] as CustomEvent<{ messageId: string; content: string }>
    expect(autoPlayEvent.type).toBe('auto-play-speech')
    expect(autoPlayEvent.detail.content).toBe('final answer')
    expect(autoPlayEvent.detail.messageId).toBe(assistantMessages[1]?.id)
    expect(autoPlayEvent.detail.messageId).not.toBe('old-a1')
    vi.useRealTimers()
  })

  it('still auto-plays genuinely new assistant text after reconnect resume', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    const session = makeSession('session-1')
    session.messages = [{
      id: 'old-a1',
      role: 'assistant',
      content: 'previous answer',
      timestamp: Date.now(),
      isStreaming: false,
    } as any]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    store.setAutoPlaySpeech(true)

    await store.sendMessage('resume run')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    const reconnectOptions = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }

    reconnectOptions.onReconnectResume({
      session_id: 'session-1',
      isWorking: true,
      messages: [{
        id: 'old-a1',
        role: 'assistant',
        content: 'previous answer',
        timestamp: Date.now() / 1000,
        finish_reason: 'stop',
      }],
      events: [],
    })

    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      output: 'new answer',
      run_id: 'run-reconnect-new-output',
    })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const autoPlayEvent = dispatchSpy.mock.calls[0][0] as CustomEvent<{ messageId: string; content: string }>
    expect(autoPlayEvent.type).toBe('auto-play-speech')
    expect(autoPlayEvent.detail.content).toBe('new answer')
    expect(autoPlayEvent.detail.messageId).not.toBe('old-a1')
    vi.useRealTimers()
  })

  it('does not auto-play an older assistant message when a run only emits tool output', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    store.setAutoPlaySpeech(true)
    store.activeSession!.messages = [{
      id: 'old-a1',
      role: 'assistant',
      content: 'previous answer',
      timestamp: Date.now(),
      isStreaming: false,
    } as any]

    handlers.onToolStarted({ event: 'tool.started', tool: 'search', tool_call_id: 'tool-1', run_id: 'run-3' })
    handlers.onToolCompleted({ event: 'tool.completed', tool_call_id: 'tool-1', output: { ok: true }, run_id: 'run-3' })
    handlers.onRunCompleted({ event: 'run.completed', parsed_content: '', output: '', run_id: 'run-3' })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    expect(dispatchSpy).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('auto-plays only the new assistant message when the current run produces one', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    store.setAutoPlaySpeech(true)
    store.activeSession!.messages = [{
      id: 'old-a1',
      role: 'assistant',
      content: 'previous answer',
      timestamp: Date.now(),
      isStreaming: false,
    } as any]

    handlers.onMessageDelta({ event: 'message.delta', delta: 'new answer', run_id: 'run-4' })
    handlers.onRunCompleted({ event: 'run.completed', parsed_content: 'new answer', output: '', run_id: 'run-4' })
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const autoPlayEvent = dispatchSpy.mock.calls[0][0] as CustomEvent<{ messageId: string; content: string }>
    expect(autoPlayEvent.type).toBe('auto-play-speech')
    expect(autoPlayEvent.detail.content).toBe('new answer')
    expect(autoPlayEvent.detail.messageId).not.toBe('old-a1')
    vi.useRealTimers()
  })

  it('preserves non-string tool.completed outputs in live session handlers', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    store.activeSession!.messages = [{
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolCallId: 'call-1',
      toolStatus: 'running',
    } as any]

    handlers.onToolCompleted({ event: 'tool.completed', tool_call_id: 'call-1', output: { ok: true }, run_id: 'run-1' })
    await nextTick()

    const tool = store.activeSession?.messages.find((message: Message) => message.id === 'tool-1')
    expect(tool?.toolStatus).toBe('done')
    expect(tool?.toolResult).toEqual({ ok: true })
  })
})
