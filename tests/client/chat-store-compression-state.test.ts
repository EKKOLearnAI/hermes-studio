// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const chatApi = vi.hoisted(() => ({
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/api/hermes/sessions', () => ({
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

    const assistant = store.activeSession?.messages.find(message => message.id === 'a1')
    expect(assistant?.content).toBe('final answer')
    expect(assistant?.isStreaming).toBe(false)
    expect(store.activeSession?.messages.some(
      message => message.role === 'system' && message.content.includes('Agent returned no output'),
    )).toBe(false)
  })

  it('does not treat an older assistant message as output for a blank run.completed event', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    store.activeSession!.messages = [{
      id: 'old-a1',
      role: 'assistant',
      content: 'previous answer',
      timestamp: Date.now(),
      isStreaming: false,
    } as any]

    handlers.onRunCompleted({ event: 'run.completed', parsed_content: '', output: '', run_id: 'run-2' })
    await nextTick()

    expect(store.activeSession?.messages.find(message => message.id === 'old-a1')?.content).toBe('previous answer')
    expect(store.activeSession?.messages.some(
      message => message.role === 'system' && message.content.includes('Agent returned no output'),
    )).toBe(true)
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

    const tool = store.activeSession?.messages.find(message => message.id === 'tool-1')
    expect(tool?.toolStatus).toBe('done')
    expect(tool?.toolResult).toEqual({ ok: true })
  })
})
