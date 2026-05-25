import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSystemPromptMock = vi.fn()
const getSessionMock = vi.fn()
const createSessionMock = vi.fn()
const addMessageMock = vi.fn()
const updateSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const updateUsageMock = vi.fn()
const buildCompressedHistoryMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn(async (_sessionId: string, _profile: string, history: any[]) => history)
const pushStateMock = vi.fn()
const replaceStateMock = vi.fn()
const forceCompressBridgeHistoryMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const updateContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, contextTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
  state.contextTokens = contextTokens
  emit('usage.updated', {
    event: 'usage.updated',
    session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens,
  })
  return contextTokens
})
const getCachedBridgeContextOverheadMock = vi.fn(() => undefined)
const contextTokensWithCachedOverheadMock = vi.fn((_state: any, messageTokens: number) => messageTokens)
const updateMessageContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => updateContextTokenUsageMock(sid, state, emit, messageTokens, usage))
const flushBridgePendingToDbMock = vi.fn()
const ensureOpenBridgeAssistantMessageMock = vi.fn()
const syncBridgeReasoningToMessageMock = vi.fn()
const recordBridgeToolStartedMock = vi.fn()
const recordBridgeToolCompletedMock = vi.fn()
const resolveBridgeRunModelConfigMock = vi.fn()

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: getSystemPromptMock,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: updateUsageMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  buildCompressedHistory: buildCompressedHistoryMock,
  buildDbHistory: buildDbHistoryMock,
  buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
  pushState: pushStateMock,
  replaceState: replaceStateMock,
  forceCompressBridgeHistory: forceCompressBridgeHistoryMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  getCachedBridgeContextOverhead: getCachedBridgeContextOverheadMock,
  contextTokensWithCachedOverhead: contextTokensWithCachedOverheadMock,
  updateContextTokenUsage: updateContextTokenUsageMock,
  updateMessageContextTokenUsage: updateMessageContextTokenUsageMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
  ensureOpenBridgeAssistantMessage: ensureOpenBridgeAssistantMessageMock,
  syncBridgeReasoningToMessage: syncBridgeReasoningToMessageMock,
  recordBridgeToolStarted: recordBridgeToolStartedMock,
  recordBridgeToolCompleted: recordBridgeToolCompletedMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/model-config', () => ({
  resolveBridgeRunModelConfig: resolveBridgeRunModelConfigMock,
}))

function makeSocket() {
  return {
    connected: true,
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
  } as any
}

function makeNamespace(emit: ReturnType<typeof vi.fn>) {
  const room = new Set(['socket-1'])
  return {
    adapter: { rooms: new Map([['session:session-1', room]]) },
    to: vi.fn(() => ({ emit })),
  } as any
}

function makeState() {
  return {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
  } as any
}

describe('bridge run final context usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSystemPromptMock.mockReturnValue('system prompt')
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '' })
    resolveBridgeRunModelConfigMock.mockResolvedValue({ model: 'gpt-test', provider: 'openai' })
    buildCompressedHistoryMock.mockResolvedValue([{ role: 'user', content: 'previous' }])
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ])
    buildSnapshotAwareHistoryMock.mockImplementation(async (_sessionId: string, _profile: string, history: any[]) => history)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 11, outputTokens: 7 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 11, outputTokens: 7 })
    getCachedBridgeContextOverheadMock.mockReturnValue(undefined)
    contextTokensWithCachedOverheadMock.mockImplementation((_state: any, messageTokens: number) => messageTokens)
  })

  it('refreshes full context tokens when a bridge run completes', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.contextEstimate).toHaveBeenCalledWith(
      'session-1',
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'done' },
      ],
      expect.stringContaining('[Current Hermes profile: default]'),
      'default',
      { model: 'gpt-test', provider: 'openai' },
    )
    expect(bridge.contextEstimate.mock.calls[0][2]).toContain('system prompt')
    expect(bridge.contextEstimate.mock.calls[0][2]).toContain('X-Hermes-Profile')
    expect(state.contextTokens).toBe(12345)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
  })

  it('uses cached fixed context instead of bridge estimate when available', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    state.bridgeContext = { fixedContextTokens: 20_000 }
    const sessionMap = new Map([['session-1', state]])
    getCachedBridgeContextOverheadMock.mockReturnValue(20_000)
    updateMessageContextTokenUsageMock.mockImplementation((sid: string, targetState: any, targetEmit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => updateContextTokenUsageMock(sid, targetState, targetEmit, 20_000 + messageTokens, usage))
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn(),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.contextEstimate).not.toHaveBeenCalled()
    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      18,
      { inputTokens: 11, outputTokens: 7 },
    )
    expect(state.contextTokens).toBe(20_018)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      contextTokens: 20_018,
    }))
  })

  it('persists pending tool marker text before a bridge run completes', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const persistedContent: string[] = []
    flushBridgePendingToDbMock.mockImplementation((targetState: any) => {
      persistedContent.push(targetState.bridgePendingAssistantContent || '')
      targetState.bridgePendingAssistantContent = ''
    })
    ensureOpenBridgeAssistantMessageMock.mockImplementation((targetState: any, sessionId: string, runMarker: string) => {
      let message = [...targetState.messages].reverse().find((m: any) => m.runMarker === runMarker && m.role === 'assistant' && m.finish_reason == null)
      if (!message) {
        message = {
          id: targetState.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: '',
          timestamp: Math.floor(Date.now() / 1000),
        }
        targetState.messages.push(message)
      }
      return message
    })
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: false, status: 'running', delta: 'Text [Call', events: [] }
        yield { run_id: 'run-1', done: true, status: 'completed', output: '', events: [] }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(persistedContent).toContain('Text [Call')
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: 'Text ',
      output: 'Text ',
    }))
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: '[Call',
      output: 'Text [Call',
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'Text [Call',
    }))
  })

  it('persists the visible plan command instead of the expanded skill prompt', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'planned' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: '[IMPORTANT: expanded plan skill prompt]',
        display_input: '/plan build the feature',
        display_role: 'command',
        storage_message: '/plan build the feature',
        session_id: 'session-1',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.find((message: any) => message.role === 'command')).toEqual(expect.objectContaining({
      role: 'command',
      content: '/plan build the feature',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/plan build the feature',
    }))
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: '[IMPORTANT: expanded plan skill prompt]',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      '[IMPORTANT: expanded plan skill prompt]',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({ storage_message: '/plan build the feature' }),
    )
  })

  it('refreshes full context tokens when a bridge run fails', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockRejectedValue(new Error('bridge timeout')),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 54321,
        message_count: 1,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.contextTokens).toBe(54321)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 54321,
    }))
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      error: 'bridge timeout',
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 54321,
    }))
  })
})
