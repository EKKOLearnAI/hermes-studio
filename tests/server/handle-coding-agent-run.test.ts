import { describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  runIdForSession: vi.fn(),
  isSessionLaunchCompatible: vi.fn(),
  stop: vi.fn(),
}))
const startCodingAgentRunMock = vi.hoisted(() => vi.fn())
const sendCodingAgentRunInputMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: managerMock,
}))

vi.mock('../../packages/server/src/services/coding-agents', () => ({
  startCodingAgentRun: startCodingAgentRunMock,
  sendCodingAgentRunInput: sendCodingAgentRunInputMock,
}))

describe('handleCodingAgentRun', () => {
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
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'use global codex')
  })
})
