import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────
const mcpListMock = vi.fn()
const mcpAddMock = vi.fn()
const mcpUpdateMock = vi.fn()
const mcpRemoveMock = vi.fn()
const mcpTestMock = vi.fn()
const mcpToolsMock = vi.fn()
const mcpReloadMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/agent-bridge/client', () => ({
  AgentBridgeClient: vi.fn().mockImplementation(() => ({
    mcpList: mcpListMock,
    mcpAdd: mcpAddMock,
    mcpUpdate: mcpUpdateMock,
    mcpRemove: mcpRemoveMock,
    mcpTest: mcpTestMock,
    mcpTools: mcpToolsMock,
    mcpReload: mcpReloadMock,
  })),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// ── Helpers ────────────────────────────────────────────────
function createCtx(overrides: Record<string, any> = {}) {
  const ctx: any = {
    state: { profile: { name: 'test-profile' } },
    request: { body: {} },
    params: {},
    query: {},
    status: 200,
    body: null,
    ...overrides,
  }
  return ctx
}

const SAMPLE_SERVERS_RESPONSE = {
  ok: true,
  servers: [
    {
      name: 'github',
      transport: 'stdio',
      connected: true,
      tools: 26,
      tools_registered: 3,
      tool_names: ['create_repository', 'search_repositories'],
      tool_names_registered: ['mcp_github_create_repository', 'mcp_github_search_repositories'],
      error: null,
      raw_config: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        tools: { include: ['create_repository', 'search_repositories'] },
        prompts: null,
        resources: null,
        enabled: true,
      },
      tool_details: [
        { name: 'create_repository', description: 'Create a repo' },
        { name: 'search_repositories', description: 'Search repos' },
      ],
    },
  ],
  total_tools: 3,
}

const SAMPLE_TOOLS_RESPONSE = {
  ok: true,
  results: [
    {
      server: 'github',
      tools: [
        { name: 'create_repository', description: 'Create a repo', input_schema: {} },
        { name: 'search_repositories', description: 'Search repos', input_schema: {} },
      ],
    },
  ],
}

// ── Tests ──────────────────────────────────────────────────
describe('MCP Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('listServers', () => {
    it('returns servers list from bridge', async () => {
      mcpListMock.mockResolvedValue(SAMPLE_SERVERS_RESPONSE)
      const { listServers } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx()
      await listServers(ctx)
      expect(ctx.body).toEqual(SAMPLE_SERVERS_RESPONSE)
      expect(mcpListMock).toHaveBeenCalledWith('test-profile')
    })

    it('returns 503 on bridge error', async () => {
      mcpListMock.mockRejectedValue(new Error('bridge down'))
      const { listServers } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx()
      await listServers(ctx)
      expect(ctx.status).toBe(503)
      expect(ctx.body).toEqual({ error: 'bridge down' })
    })
  })

  describe('addServer', () => {
    it('sends name and config to bridge', async () => {
      mcpAddMock.mockResolvedValue({ ok: true, name: 'my-server' })
      const { addServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ request: { body: { name: 'my-server', config: { command: 'node', args: ['srv.js'] } } } })
      await addServer(ctx)
      expect(mcpAddMock).toHaveBeenCalledWith('my-server', { command: 'node', args: ['srv.js'] }, 'test-profile')
      expect(ctx.body).toEqual({ ok: true, name: 'my-server' })
    })

    it('returns 400 when name is missing', async () => {
      const { addServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ request: { body: { config: { command: 'x' } } } })
      await addServer(ctx)
      expect(ctx.status).toBe(400)
      expect(mcpAddMock).not.toHaveBeenCalled()
    })

    it('returns 400 when config is missing', async () => {
      const { addServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ request: { body: { name: 'x' } } })
      await addServer(ctx)
      expect(ctx.status).toBe(400)
    })
  })

  describe('updateServer', () => {
    it('sends name from params and config to bridge', async () => {
      mcpUpdateMock.mockResolvedValue({ ok: true })
      const { updateServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({
        params: { name: 'github' },
        request: { body: { config: { tools: { include: ['a', 'b'] } } } },
      })
      await updateServer(ctx)
      expect(mcpUpdateMock).toHaveBeenCalledWith('github', { tools: { include: ['a', 'b'] } }, 'test-profile')
    })

    it('returns 400 when config is missing', async () => {
      const { updateServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ params: { name: 'github' }, request: { body: {} } })
      await updateServer(ctx)
      expect(ctx.status).toBe(400)
    })

    it('sends tools.include config for include mode', async () => {
      mcpUpdateMock.mockResolvedValue({ ok: true })
      const { updateServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({
        params: { name: 'github' },
        request: { body: { config: { command: 'npx', args: ['-y', 'server'], tools: { include: ['read_file', 'write_file'] } } } },
      })
      await updateServer(ctx)
      expect(mcpUpdateMock).toHaveBeenCalledWith('github', {
        command: 'npx',
        args: ['-y', 'server'],
        tools: { include: ['read_file', 'write_file'] },
      }, 'test-profile')
      expect(ctx.body).toEqual({ ok: true })
    })

    it('sends tools.exclude config for exclude mode', async () => {
      mcpUpdateMock.mockResolvedValue({ ok: true })
      const { updateServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({
        params: { name: 'github' },
        request: { body: { config: { command: 'npx', args: ['-y', 'server'], tools: { exclude: ['delete_file'] } } } },
      })
      await updateServer(ctx)
      expect(mcpUpdateMock).toHaveBeenCalledWith('github', {
        command: 'npx',
        args: ['-y', 'server'],
        tools: { exclude: ['delete_file'] },
      }, 'test-profile')
      expect(ctx.body).toEqual({ ok: true })
    })

    it('sends config without tools field for all mode', async () => {
      mcpUpdateMock.mockResolvedValue({ ok: true })
      const { updateServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({
        params: { name: 'github' },
        request: { body: { config: { command: 'npx', args: ['-y', 'server'] } } },
      })
      await updateServer(ctx)
      expect(mcpUpdateMock).toHaveBeenCalledWith('github', {
        command: 'npx',
        args: ['-y', 'server'],
      }, 'test-profile')
      expect(ctx.body).toEqual({ ok: true })
    })
  })

  describe('removeServer', () => {
    it('sends name to bridge', async () => {
      mcpRemoveMock.mockResolvedValue({ ok: true })
      const { removeServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ params: { name: 'github' } })
      await removeServer(ctx)
      expect(mcpRemoveMock).toHaveBeenCalledWith('github', 'test-profile')
    })
  })

  describe('testServer', () => {
    it('returns tool list from bridge', async () => {
      mcpTestMock.mockResolvedValue({ ok: true, tools: ['create_repository', 'search_repositories'] })
      const { testServer } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ params: { name: 'github' } })
      await testServer(ctx)
      expect(mcpTestMock).toHaveBeenCalledWith('github', 'test-profile')
      expect(ctx.body).toEqual({ ok: true, tools: ['create_repository', 'search_repositories'] })
    })
  })

  describe('listTools', () => {
    it('returns tools without server filter', async () => {
      mcpToolsMock.mockResolvedValue(SAMPLE_TOOLS_RESPONSE)
      const { listTools } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ query: {} })
      await listTools(ctx)
      expect(mcpToolsMock).toHaveBeenCalledWith(undefined, 'test-profile', undefined)
      expect(ctx.body).toEqual(SAMPLE_TOOLS_RESPONSE)
    })

    it('passes server filter to bridge', async () => {
      mcpToolsMock.mockResolvedValue(SAMPLE_TOOLS_RESPONSE)
      const { listTools } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ query: { server: 'github' } })
      await listTools(ctx)
      expect(mcpToolsMock).toHaveBeenCalledWith('github', 'test-profile', undefined)
    })

    it('passes raw=true to get unfiltered tools', async () => {
      mcpToolsMock.mockResolvedValue(SAMPLE_TOOLS_RESPONSE)
      const { listTools } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ query: { server: 'github', raw: '1' } })
      await listTools(ctx)
      expect(mcpToolsMock).toHaveBeenCalledWith('github', 'test-profile', true)
    })

    it('returns 503 on bridge error', async () => {
      mcpToolsMock.mockRejectedValue(new Error('timeout'))
      const { listTools } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx()
      await listTools(ctx)
      expect(ctx.status).toBe(503)
    })
  })

  describe('reloadMcp', () => {
    it('reloads all servers when no filter', async () => {
      mcpReloadMock.mockResolvedValue({ ok: true, message: 'MCP servers reloaded' })
      const { reloadMcp } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ query: {} })
      await reloadMcp(ctx)
      expect(mcpReloadMock).toHaveBeenCalledWith(undefined, 'test-profile')
    })

    it('reloads specific server', async () => {
      mcpReloadMock.mockResolvedValue({ ok: true, message: 'MCP servers reloaded' })
      const { reloadMcp } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ query: { server: 'github' } })
      await reloadMcp(ctx)
      expect(mcpReloadMock).toHaveBeenCalledWith('github', 'test-profile')
    })

    it('returns 503 on bridge error', async () => {
      mcpReloadMock.mockRejectedValue(new Error('reload failed'))
      const { reloadMcp } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx()
      await reloadMcp(ctx)
      expect(ctx.status).toBe(503)
    })
  })

  describe('profile handling', () => {
    it('passes undefined profile when ctx.state.profile is missing', async () => {
      mcpListMock.mockResolvedValue({ ok: true, servers: [], total_tools: 0 })
      const { listServers } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ state: {} })
      await listServers(ctx)
      expect(mcpListMock).toHaveBeenCalledWith(undefined)
    })

    it('passes undefined profile when profile.name is empty', async () => {
      mcpListMock.mockResolvedValue({ ok: true, servers: [], total_tools: 0 })
      const { listServers } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx({ state: { profile: { name: '' } } })
      await listServers(ctx)
      expect(mcpListMock).toHaveBeenCalledWith(undefined)
    })
  })

  describe('response structure', () => {
    it('mcp_list response has all required fields', async () => {
      mcpListMock.mockResolvedValue(SAMPLE_SERVERS_RESPONSE)
      const { listServers } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx()
      await listServers(ctx)
      const body = ctx.body as any
      expect(body.ok).toBe(true)
      expect(body.servers).toBeDefined()
      expect(body.total_tools).toBeDefined()
      const server = body.servers[0]
      expect(server).toHaveProperty('name')
      expect(server).toHaveProperty('transport')
      expect(server).toHaveProperty('connected')
      expect(server).toHaveProperty('tools')
      expect(server).toHaveProperty('tools_registered')
      expect(server).toHaveProperty('tool_names')
      expect(server).toHaveProperty('tool_names_registered')
      expect(server).toHaveProperty('raw_config')
      expect(server).toHaveProperty('tool_details')
      expect(server.raw_config).toHaveProperty('command')
      expect(server.raw_config).toHaveProperty('enabled')
    })

    it('mcp_tools_list response has tools with name/description/schema', async () => {
      mcpToolsMock.mockResolvedValue(SAMPLE_TOOLS_RESPONSE)
      const { listTools } = await import('../../packages/server/src/controllers/hermes/mcp')
      const ctx = createCtx()
      await listTools(ctx)
      const body = ctx.body as any
      expect(body.ok).toBe(true)
      expect(body.results).toHaveLength(1)
      const tool = body.results[0].tools[0]
      expect(tool).toHaveProperty('name')
      expect(tool).toHaveProperty('description')
      expect(tool).toHaveProperty('input_schema')
    })
  })
})
