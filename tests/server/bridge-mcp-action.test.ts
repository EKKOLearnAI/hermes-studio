import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────
const mcpToolsMock = vi.fn()
const mcpToolCallMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/agent-bridge/client', () => ({
  AgentBridgeClient: vi.fn().mockImplementation(() => ({
    mcpTools: mcpToolsMock,
    mcpToolCall: mcpToolCallMock,
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

  it('keeps MCP execution out of the generic management dispatcher', async () => {
    const { bridgeMcpAction } = await import('../../packages/server/src/services/hermes/mcp')
    await expect(bridgeMcpAction('mcp_tool_call', {
      server: 'bilibili', tool: 'search_videos', arguments: {},
    }, 'default')).rejects.toThrow(/unknown MCP action/i)
    expect(mcpToolCallMock).not.toHaveBeenCalled()
  })

  it('exposes one typed server-internal call boundary', async () => {
    mcpToolCallMock.mockResolvedValue({
      ok: true, server: 'bilibili', tool: 'search_videos', status: 'succeeded', error_code: null, result: {},
    })
    const { callProfileMcpTool } = await import('../../packages/server/src/services/hermes/mcp')
    await callProfileMcpTool({
      profile: 'default', server: 'bilibili', tool: 'search_videos', arguments: { query: 'Hermes' }, timeoutMs: 12_000,
    })
    expect(mcpToolCallMock).toHaveBeenCalledWith(
      'bilibili', 'search_videos', { query: 'Hermes' }, 'default', 12_000,
    )
  })
})
