// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApiMocks = vi.hoisted(() => ({
  lastRunEventHandler: null as null | ((evt: any) => void),
  startRunViaSocket: vi.fn((_payload: any, onEvent: (evt: any) => void) => {
    chatApiMocks.lastRunEventHandler = onEvent
    return { abort: vi.fn() }
  }),
  resumeSession: vi.fn((sessionId: string, onResumed: (data: any) => void) => {
    onResumed({ session_id: sessionId, messages: [], isWorking: false, events: [] })
    return {} as any
  }),
  registerSessionHandlers: vi.fn(() => vi.fn()),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  submitApprovalViaSocket: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => chatApiMocks)

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
}))

vi.mock('@/api/client', () => ({
  getApiKey: vi.fn(() => ''),
}))

import { useChatStore } from '@/stores/hermes/chat'

describe('chat store approval commands', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('submits /approve through the active streaming run instead of starting a new run', async () => {
    const store = useChatStore()

    store.newChat()
    const sessionId = store.activeSessionId!
    await store.sendMessage('start risky work')
    expect(chatApiMocks.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(store.isStreaming).toBe(true)

    await store.sendMessage('/approve session')

    expect(chatApiMocks.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(chatApiMocks.submitApprovalViaSocket).toHaveBeenCalledWith(sessionId, 'session', false)
    expect(store.messages.at(-1)?.role).toBe('user')
    expect(store.messages.at(-1)?.content).toBe('/approve session')
  })

  it('queues ordinary chat text while a run is streaming', async () => {
    const store = useChatStore()

    store.newChat()
    await store.sendMessage('start risky work')
    expect(store.isStreaming).toBe(true)

    await store.sendMessage('this should queue behind the active run')

    expect(chatApiMocks.startRunViaSocket).toHaveBeenCalledTimes(2)
    expect(chatApiMocks.startRunViaSocket.mock.calls[1][0]).toMatchObject({
      input: 'this should queue behind the active run',
      session_id: store.activeSessionId,
    })
    expect(chatApiMocks.startRunViaSocket.mock.calls[1][0].queue_id).toEqual(expect.any(String))
    expect(chatApiMocks.submitApprovalViaSocket).not.toHaveBeenCalled()
    expect(store.messages.map(m => m.content)).not.toContain('this should queue behind the active run')
  })

  it('deduplicates repeated approval request pattern labels', async () => {
    const store = useChatStore()

    store.newChat()
    await store.sendMessage('start risky work')
    const onEvent = chatApiMocks.lastRunEventHandler
    expect(onEvent).toEqual(expect.any(Function))

    onEvent?.({
      event: 'approval.request',
      run_id: 'run-approval-1',
      command: "bash -lc 'printf ok'",
      description: 'shell command via -c/-lc flag',
      pattern_key: 'shell command via -c/-lc flag',
      pattern_keys: ['shell command via -c/-lc flag'],
      choices: ['once', 'session', 'always', 'deny'],
    })

    const approvalPrompt = store.messages.find(m =>
      m.role === 'system' && m.content.includes('Approval required'),
    )
    expect(approvalPrompt?.content).toContain('Patterns: shell command via -c/-lc flag')
    expect(approvalPrompt?.content).not.toContain('shell command via -c/-lc flag, shell command via -c/-lc flag')
  })

  it('deduplicates the optimistic and upstream approval response for the same run', async () => {
    const store = useChatStore()

    store.newChat()
    await store.sendMessage('start risky work')
    const onEvent = chatApiMocks.lastRunEventHandler
    expect(onEvent).toEqual(expect.any(Function))

    onEvent?.({
      event: 'approval.responded',
      run_id: 'run-approval-1',
      choice: 'once',
      all: false,
      resolved: 1,
    })
    onEvent?.({
      event: 'approval.responded',
      run_id: 'run-approval-1',
      timestamp: Date.now() / 1000,
      choice: 'once',
      resolved: 1,
    })

    const approvalResponses = store.messages.filter(m =>
      m.role === 'system' && m.content.includes('Approval approved once. Resolved 1 pending request.'),
    )
    expect(approvalResponses).toHaveLength(1)
  })
})
