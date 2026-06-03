import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────
const mcpToolsMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/agent-bridge/client', () => ({
  AgentBridgeClient: vi.fn().mockImplementation(() => ({
    mcpTools: mcpToolsMock,
  })),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// ── Tests ──────────────────────────────────────────────────
describe('bridgeMcpAction - mcp_tools_list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes server and profile to client.mcpTools', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/services/hermes/mcp')
    await bridgeMcpAction('mcp_tools_list', { server: 'github' }, 'test-profile')
    expect(mcpToolsMock).toHaveBeenCalledWith('github', 'test-profile', undefined)
  })

  it('passes raw=true to client.mcpTools', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/services/hermes/mcp')
    await bridgeMcpAction('mcp_tools_list', { server: 'github', raw: true }, 'test-profile')
    expect(mcpToolsMock).toHaveBeenCalledWith('github', 'test-profile', true)
  })

  it('passes raw=false to client.mcpTools', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/services/hermes/mcp')
    await bridgeMcpAction('mcp_tools_list', { server: 'github', raw: false }, 'test-profile')
    expect(mcpToolsMock).toHaveBeenCalledWith('github', 'test-profile', false)
  })

  it('passes undefined server when not provided', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/services/hermes/mcp')
    await bridgeMcpAction('mcp_tools_list', {}, 'test-profile')
    expect(mcpToolsMock).toHaveBeenCalledWith(undefined, 'test-profile', undefined)
  })

  it('passes undefined profile when not provided', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/services/hermes/mcp')
    await bridgeMcpAction('mcp_tools_list', { server: 'github' })
    expect(mcpToolsMock).toHaveBeenCalledWith('github', undefined, undefined)
  })
})
