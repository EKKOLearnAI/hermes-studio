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
const updateSessionMock = vi.hoisted(() => vi.fn())

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
  updateSession: updateSessionMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('handleCodingAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue(null)
    managerMock.isSessionProcessing.mockReturnValue(false)
    writeModelRunProfileTokenMock.mockResolvedValue(undefined)
    getSystemPromptMock.mockReturnValue('system prompt')
  })

  it('restarts an existing coding-agent runner when the requested launch mode changes', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(false)
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-2' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-2' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'use global codex',
      coding_agent_id: 'codex',
      mode: 'global',
    }, 'default', sessionMap as any)

    expect(managerMock.isSessionLaunchCompatible).toHaveBeenCalledWith('session-1', {
      agentId: 'codex',
      mode: 'global',
      provider: undefined,
      model: undefined,
    })
    expect(managerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'session-1',
      mode: 'global',
      profile: 'default',
    }), state)
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'use global codex', 'system prompt')
  })

  it('restarts an existing scoped runner when the stored session model changed even if the socket payload omits it', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(false)
    getSessionMock.mockReturnValue({
      id: 'session-1',
      source: 'coding_agent',
      agent: 'codex',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-2' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-2' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'continue with new model',
      coding_agent_id: 'codex',
      mode: 'scoped',
    }, 'default', sessionMap as any)

    expect(managerMock.isSessionLaunchCompatible).toHaveBeenCalledWith('session-1', {
      agentId: 'codex',
      mode: 'scoped',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    expect(managerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'session-1',
      mode: 'scoped',
      profile: 'default',
    }), state)
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'continue with new model', 'system prompt')
  })

  it('passes global session source through to the coding-agent runner', async () => {
    managerMock.runIdForSession.mockReturnValue(undefined)
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-1' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'hello codex',
      coding_agent_id: 'codex',
      session_source: 'global_agent',
    }, 'default', sessionMap as any)

    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'session-1',
      sessionSource: 'global_agent',
    }), state)
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'hello codex', 'system prompt')
  })

  it('passes the Hermes system prompt on every scoped Claude Code run', async () => {
    managerMock.runIdForSession.mockReturnValue(undefined)
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-1' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'hello claude',
      coding_agent_id: 'claude-code',
    }, 'default', sessionMap as any)

    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'hello claude', 'system prompt')
  })

  it('reopens an ended coding-agent session before sending a new input', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      source: 'coding_agent',
      agent: 'codex',
      ended_at: 123,
      end_reason: 'complete',
    })

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'continue',
      coding_agent_id: 'codex',
    }, 'default', sessionMap as any)

    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      ended_at: null,
      end_reason: null,
      last_active: expect.any(Number),
    }))
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'continue', 'system prompt')
  })

  it('marks a reopened coding-agent session as errored when input send fails before processing starts', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    managerMock.isSessionProcessing.mockReturnValue(false)
    sendCodingAgentRunInputMock.mockRejectedValue(new Error('send failed'))

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await expect(handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'continue',
      coding_agent_id: 'codex',
    }, 'default', sessionMap as any)).rejects.toThrow('send failed')

    expect(updateSessionMock.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({
        ended_at: null,
        end_reason: null,
        last_active: expect.any(Number),
      }),
      expect.objectContaining({
        ended_at: expect.any(Number),
        end_reason: 'error',
      }),
    ])
    expect(state.isWorking).toBe(false)
  })

  it('keeps profile token handling separate from the system prompt for authenticated users', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })
    writeModelRunProfileTokenMock.mockResolvedValue(undefined)
    getSystemPromptMock.mockReturnValue([
      'system prompt',
      'Hermes Studio MCP usage: call hermes_studio_api_openapi_get before calling unfamiliar Web UI endpoints.',
      'Use hermes_studio_api_request with method, relative path, and JSON body/query fields.',
    ].join('\n'))

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      data: { user: { id: 1, username: 'admin', role: 'super_admin' } },
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'hello codex',
      coding_agent_id: 'codex',
    }, 'default', sessionMap as any)

    expect(writeModelRunProfileTokenMock).toHaveBeenCalledWith(
      { id: 1, username: 'admin', role: 'super_admin' },
      'default',
    )
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith(
      'session-1',
      'hello codex',
      expect.stringContaining('system prompt\nHermes Studio MCP usage'),
    )
    const prompt = sendCodingAgentRunInputMock.mock.calls.at(-1)?.[2]
    expect(prompt).toContain('hermes_studio_api_request')
    expect(prompt).not.toContain('run-token')
    expect(prompt).not.toContain('[Current Hermes profile:')
    expect(prompt).not.toContain('Current Hermes Web UI model run token')
    expect(prompt).not.toContain('Hermes Web UI LAN device capabilities are MCP tools')
    expect(prompt).not.toContain('list_mcp_resources')
    expect(prompt).not.toContain('mcp__hermes-studio__')
  })
})
