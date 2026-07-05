import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  runIdForSession: vi.fn(),
  isSessionLaunchCompatible: vi.fn(),
  isSessionProcessing: vi.fn(),
  stop: vi.fn(),
}))
const startCodingAgentRunMock = vi.hoisted(() => vi.fn())
const sendCodingAgentRunInputMock = vi.hoisted(() => vi.fn())
const writeModelRunProfileTokenMock = vi.hoisted(() => vi.fn(async () => undefined))
const getSystemPromptMock = vi.hoisted(() => vi.fn(() => 'system prompt'))
const getSessionMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: managerMock,
}))
vi.mock('../../packages/server/src/services/coding-agents', () => ({
  startCodingAgentRun: startCodingAgentRunMock,
  sendCodingAgentRunInput: sendCodingAgentRunInputMock,
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/model-run-prompt', () => ({
  writeModelRunProfileToken: writeModelRunProfileTokenMock,
}))
vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: getSystemPromptMock,
}))
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
}))

function state() {
  return {
    messages: [],
    isWorking: false,
    isAborting: false,
    events: [],
    queue: [],
  } as any
}

function socket() {
  return {
    data: {},
    join: vi.fn(),
    emit: vi.fn(),
  }
}

describe('coding-agent dispatch baseline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    managerMock.runIdForSession.mockReturnValue(undefined)
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    managerMock.isSessionProcessing.mockReturnValue(false)
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-1' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })
    writeModelRunProfileTokenMock.mockResolvedValue(undefined)
    getSystemPromptMock.mockReturnValue('system prompt')
    getSessionMock.mockReturnValue(null)
  })

  it('dispatches an explicit coding_agent_id and passes local proxy fields through', async () => {
    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const runState = state()
    const sessionMap = new Map([['session-1', runState]])
    const runSocket = socket()

    await handleCodingAgentRun({} as any, runSocket as any, {
      session_id: 'session-1',
      input: 'hello codex',
      source: 'coding_agent',
      coding_agent_id: 'codex',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: 'local-test-key',
      apiMode: 'responses',
    }, 'default', sessionMap as any)

    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'session-1',
      mode: 'scoped',
      profile: 'default',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: 'local-test-key',
      apiMode: 'responses',
    }), runState)
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'hello codex', 'system prompt')
  })

  it('uses agent_id as an alias when coding_agent_id is omitted', async () => {
    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const runState = state()
    const sessionMap = new Map([['session-1', runState]])

    await handleCodingAgentRun({} as any, socket() as any, {
      session_id: 'session-1',
      input: 'hello alias',
      source: 'coding_agent',
      agent_id: 'codex',
      base_url: 'http://127.0.0.1:2345',
      api_key: 'alias-test-key',
      api_mode: 'chat_completions',
    }, 'default', sessionMap as any)

    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      baseUrl: 'http://127.0.0.1:2345',
      apiKey: 'alias-test-key',
      apiMode: 'chat_completions',
    }), runState)
  })

  it('stringifies ContentBlock input before sending it to the coding agent', async () => {
    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const blocks = [{ type: 'text', text: 'hello blocks' }]

    await handleCodingAgentRun({} as any, socket() as any, {
      session_id: 'session-1',
      input: blocks as any,
      coding_agent_id: 'claude-code',
    }, 'default', new Map([['session-1', state()]]) as any)

    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', JSON.stringify(blocks), 'system prompt')
  })

  it('fails fast when session_id is missing', async () => {
    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const runSocket = socket()

    await handleCodingAgentRun({} as any, runSocket as any, {
      input: 'missing session',
      coding_agent_id: 'codex',
    }, 'default', new Map() as any)

    expect(runSocket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      error: 'session_id is required for coding agent runs',
    })
    expect(startCodingAgentRunMock).not.toHaveBeenCalled()
  })
})
