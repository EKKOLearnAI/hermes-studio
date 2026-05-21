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
const pushStateMock = vi.fn()
const replaceStateMock = vi.fn()
const forceCompressBridgeHistoryMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
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
  pushState: pushStateMock,
  replaceState: replaceStateMock,
  forceCompressBridgeHistory: forceCompressBridgeHistoryMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
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
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 11, outputTokens: 7 })
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
      'system prompt',
      'default',
      { model: 'gpt-test', provider: 'openai' },
    )
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
