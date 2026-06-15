import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  runIdForSession: vi.fn(),
  isSessionLaunchCompatible: vi.fn(),
  stop: vi.fn(),
}))
const startCodingAgentRunMock = vi.hoisted(() => vi.fn())
const sendCodingAgentRunInputMock = vi.hoisted(() => vi.fn())
const buildModelRunAuthPromptMock = vi.hoisted(() => vi.fn(async () => []))
const getSystemPromptMock = vi.hoisted(() => vi.fn(() => 'system prompt'))

vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: managerMock,
}))

vi.mock('../../packages/server/src/services/coding-agents', () => ({
  startCodingAgentRun: startCodingAgentRunMock,
  sendCodingAgentRunInput: sendCodingAgentRunInputMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/model-run-prompt', () => ({
  buildModelRunAuthPrompt: buildModelRunAuthPromptMock,
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: getSystemPromptMock,
}))

describe('handleCodingAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildModelRunAuthPromptMock.mockResolvedValue([])
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

  it('passes per-run MCP auth prompt separately from coding-agent input for authenticated users', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })
    buildModelRunAuthPromptMock.mockResolvedValue([
      '[Current Hermes profile: default]',
      '[Current Hermes Web UI model run token: run-token]',
    ])

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

    expect(buildModelRunAuthPromptMock).toHaveBeenCalledWith(
      { id: 1, username: 'admin', role: 'super_admin' },
      'default',
    )
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith(
      'session-1',
      'hello codex',
      expect.stringContaining('system prompt\n[Current Hermes profile: default]\n[Current Hermes Web UI model run token: run-token]'),
    )
    const prompt = sendCodingAgentRunInputMock.mock.calls.at(-1)?.[2]
    expect(prompt).toContain('Hermes Web UI LAN device capabilities are MCP tools')
    expect(prompt).toContain('Do not use list_mcp_resources or list_mcp_resource_templates')
    expect(prompt).toContain('mcp__hermes-studio__hermes_lan_devices_scan')
    expect(prompt).toContain('mcp__hermes-studio__hermes_lan_devices_list')
  })
})
