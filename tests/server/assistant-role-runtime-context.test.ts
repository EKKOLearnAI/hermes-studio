import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  runIdForSession: vi.fn(() => 'agent-session-1'),
  isSessionLaunchCompatible: vi.fn(() => true),
  isSessionProcessing: vi.fn(() => true),
  stop: vi.fn(),
}))
const sendCodingAgentRunInputMock = vi.hoisted(() => vi.fn(async () => ({ runId: 'agent-session-1' })))
const buildSafeRoleContextInstructionsForProfileMock = vi.hoisted(() => vi.fn(() => ''))

vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: managerMock,
}))
vi.mock('../../packages/server/src/services/coding-agents', () => ({
  startCodingAgentRun: vi.fn(),
  sendCodingAgentRunInput: sendCodingAgentRunInputMock,
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/model-run-prompt', () => ({
  writeModelRunProfileToken: vi.fn(async () => undefined),
}))
vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))
vi.mock('../../packages/server/src/services/hermes/personal-twin/role-context', () => ({
  buildSafeRoleContextInstructionsForProfile: buildSafeRoleContextInstructionsForProfileMock,
}))

function runtime() {
  return {
    nsp: {} as any,
    socket: { data: {}, join: vi.fn(), emit: vi.fn() } as any,
    state: { messages: [], isWorking: false, events: [], queue: [] },
  }
}

describe('assistant role runtime context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    buildSafeRoleContextInstructionsForProfileMock.mockReturnValue('')
  })

  it('injects the mapped role context into Coding Agent prompts with a normalized bounded query', async () => {
    buildSafeRoleContextInstructionsForProfileMock.mockReturnValue('# Assistant Role Context\nPersona: fitness coach')
    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const { nsp, socket, state } = runtime()
    const longTail = 'x'.repeat(3_000)

    await handleCodingAgentRun(nsp, socket, {
      session_id: 'session-1',
      input: [{ type: 'text', text: `  How   should\nI train? ${longTail}` }],
      coding_agent_id: 'codex',
    }, 'coach', new Map([['session-1', state]]) as any)

    const query = buildSafeRoleContextInstructionsForProfileMock.mock.calls[0][1].query as string
    expect(buildSafeRoleContextInstructionsForProfileMock.mock.calls[0][0]).toBe('coach')
    expect(query.startsWith('How should I train?')).toBe(true)
    expect(query.length).toBe(2_000)
    const prompt = sendCodingAgentRunInputMock.mock.calls[0][2] as string
    expect(prompt).toBe('system prompt\n# Assistant Role Context\nPersona: fitness coach')
    expect(prompt.match(/# Assistant Role Context/g)).toHaveLength(1)
  })

  it('keeps the existing base prompt when role context generation returns empty', async () => {
    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    const { nsp, socket, state } = runtime()

    await handleCodingAgentRun(nsp, socket, {
      session_id: 'session-1',
      input: 'hello',
      coding_agent_id: 'claude-code',
    }, 'default', new Map([['session-1', state]]) as any)

    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'hello', 'system prompt')
  })
})
