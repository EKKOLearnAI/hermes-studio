import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.hoisted(() => vi.fn(() => 1))
const getSessionMock = vi.hoisted(() => vi.fn())
const updateSessionStatsMock = vi.hoisted(() => vi.fn())
const getOrCreateSessionMock = vi.hoisted(() => vi.fn(() => ({ messages: [], isWorking: false })))
const forceCompressBridgeHistoryMock = vi.hoisted(() => vi.fn())
const calcAndUpdateUsageMock = vi.hoisted(() => vi.fn())
const getModelContextLengthMock = vi.hoisted(() => vi.fn(() => 256_000))
const compactMock = vi.hoisted(() => vi.fn())
const getRunInfoMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
  getSession: getSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  getOrCreateSession: getOrCreateSessionMock,
  forceCompressBridgeHistory: forceCompressBridgeHistoryMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: getModelContextLengthMock,
}))

vi.mock('../../packages/server/src/services/coding-agents/runtime/run-manager', () => ({
  codingAgentRunManager: {
    compact: compactMock,
    getRunInfo: getRunInfoMock,
  },
}))

function makeSocket() {
  const emitted: Array<{ event: string; payload: any }> = []
  return {
    emitted,
    socket: {
      id: 'socket-1',
      connected: true,
      join: vi.fn(),
      emit: (event: string, payload: any) => emitted.push({ event, payload }),
    },
    nsp: {
      adapter: { rooms: new Map() },
      to: () => ({
        emit: () => {},
      }),
    } as any,
  }
}

describe('coding agent session commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addMessageMock.mockReturnValue(1)
    getOrCreateSessionMock.mockReturnValue({ messages: [], isWorking: false })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 10, outputTokens: 20 })
    getModelContextLengthMock.mockReturnValue(256_000)
  })

  it('parses CLI-style coding agent commands', async () => {
    const { parseCodingAgentSessionCommand } = await import('../../packages/server/src/services/coding-agents/session-command')
    expect(parseCodingAgentSessionCommand('/compact')?.name).toBe('compact')
    expect(parseCodingAgentSessionCommand('/compact focus on auth')?.args).toBe('focus on auth')
    expect(parseCodingAgentSessionCommand('/context')?.name).toBe('context')
    expect(parseCodingAgentSessionCommand('/usage')?.name).toBe('usage')
    expect(parseCodingAgentSessionCommand('/status')?.name).toBe('status')
    expect(parseCodingAgentSessionCommand('/model gpt-5')).toBeNull()
    expect(parseCodingAgentSessionCommand('hello')).toBeNull()
  })

  it('emits context usage for coding agent sessions', async () => {
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/services/coding-agents/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
      model: 'test-model',
      provider: 'openrouter',
    }, { name: 'context', rawName: 'context', args: '' }, 'default', new Map())

    const command = emitted.find(item => item.event === 'session.command')?.payload
    expect(command.action).toBe('context')
    expect(command.message).toContain('total 30 / 256000 tokens')
    expect(command.contextPercent).toBe(0)
  })

  it('emits native compact completion for Codex', async () => {
    compactMock.mockResolvedValue({ compacted: true, summary: 'summarized old history' })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/services/coding-agents/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())

    const command = emitted.find(item => item.event === 'session.command')?.payload
    expect(command.action).toBe('compact')
    expect(command.compacted).toBe(true)
    expect(command.message).toContain('summarized old history')
  })

  it('falls back to Studio ChatContextCompressor when native compact fails', async () => {
    compactMock.mockRejectedValue(new Error('native compact unsupported'))
    forceCompressBridgeHistoryMock.mockResolvedValue({
      beforeMessages: 20,
      resultMessages: 4,
      beforeTokens: 50_000,
      afterTokens: 3_000,
      compressed: true,
    })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/services/coding-agents/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())

    const command = emitted.find(item => item.event === 'session.command')?.payload
    expect(command.action).toBe('compact')
    expect(command.compacted).toBe(true)
    expect(command.message).toContain('Studio compressed its transcript')
    expect(forceCompressBridgeHistoryMock).toHaveBeenCalledWith('session-1', 'default', [])
  })

  it('emits coding agent status from the run manager', async () => {
    getRunInfoMock.mockReturnValue({
      exists: true,
      running: false,
      agentId: 'codex',
      model: 'test-model',
      provider: 'openrouter',
      workspaceDir: '/tmp/work',
      nativeSessionId: 'thread-1',
      messageCount: 4,
    })
    getSessionMock.mockReturnValue({ agent: 'codex', model: 'test-model', provider: 'openrouter' })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/services/coding-agents/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'status', rawName: 'status', args: '' }, 'default', new Map())

    const command = emitted.find(item => item.event === 'session.command')?.payload
    expect(command.action).toBe('status')
    expect(command.nativeSessionId).toBe('thread-1')
    expect(command.message).toContain('agent: codex')
  })
})
