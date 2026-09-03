import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureProfileConfig } from '../../packages/server/src/modules/studio/public/profile-config'

const bridgeMcpAction = vi.hoisted(() => vi.fn(async (action: string) => {
  if (action === 'mcp_list') {
    return {
      ok: true,
      total_tools: 2,
      servers: [{
        name: 'hermes-studio-api',
        transport: 'stdio',
        connected: true,
        tools: 2,
        tools_registered: 2,
        tool_names: ['hermes_studio_api_openapi_get', 'hermes_studio_api_request'],
        tool_names_registered: ['hermes_studio_api_openapi_get', 'hermes_studio_api_request'],
      }],
    }
  }
  return { ok: true, tools: ['tool_a'] }
}))

vi.mock('../../packages/server/src/modules/hermes/services/mcp/bridge-actions', () => ({
  bridgeMcpAction,
}))

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    async connect() {}
    async listTools() {
      return { tools: [{ name: 'custom_tool' }] }
    }
    async close() {}
  },
  SSEClientTransport: class {},
  StreamableHTTPClientTransport: class {},
}))

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: class {},
}))

import {
  listCodingAgentMcpServers,
  removeCodingAgentMcpServer,
  testCodingAgentMcpServer,
  upsertCodingAgentMcpServer,
} from '../../packages/server/src/modules/coding-agents/services/mcp-manager'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-mcp-'))
  homes.push(home)
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = home
  configureProfileConfig({
    buildModelGroups: () => ({ default: '', groups: [] }),
    getProfilesBaseDir: () => join(home, 'profiles'),
    getProfileDir: profile => join(home, 'profiles', profile),
    getActiveProfileName: () => 'default',
    listProfileNames: () => ['default'],
    providerEnvironmentMap: {},
    readConfigYaml: async () => ({}),
    readConfigYamlForProfile: async () => ({}),
    safeReadFile: async filePath => existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
    saveEnvValue: async () => undefined,
    saveEnvValueForProfile: async () => undefined,
    updateConfigYaml: async () => undefined,
    updateConfigYamlForProfile: async () => undefined,
  })
  return home
}

afterEach(() => {
  bridgeMcpAction.mockClear()
  delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('coding Agent MCP manager', () => {
  it('manages Claude JSON while preserving unrelated root configuration', async () => {
    const home = makeHome()
    const path = join(home, '.claude', 'mcp.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      enabledMcpjsonServers: ['docs'],
      mcpServers: {
        docs: { url: 'https://example.com/mcp', enabled: true },
      },
    }, null, 2)}\n`)

    const initial = await listCodingAgentMcpServers('claude-code')
    expect(initial.servers.map(server => server.name)).toEqual(expect.arrayContaining([
      'docs',
      'hermes-studio-api',
      'hermes-studio-browser',
      'hermes-studio-devices',
      'hermes-studio-use',
    ]))
    expect(initial.servers.find(server => server.name === 'hermes-studio-api')).toMatchObject({
      managed: true,
      connected: true,
      tools_registered: 2,
    })

    await upsertCodingAgentMcpServer('claude-code', 'search', {
      command: 'node',
      args: ['search.mjs'],
      enabled: true,
    })
    await removeCodingAgentMcpServer('claude-code', 'docs')

    const persisted = JSON.parse(readFileSync(path, 'utf-8'))
    expect(persisted.enabledMcpjsonServers).toEqual(['docs'])
    expect(persisted.mcpServers).toEqual({
      search: { command: 'node', args: ['search.mjs'], enabled: true },
    })
    expect(persisted.mcpServers['hermes-studio-api']).toBeUndefined()
  })

  it('preserves Pi MCP settings and rejects malformed JSON instead of overwriting it', async () => {
    const home = makeHome()
    const path = join(home, '.pi', 'agent', 'mcp.json')
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      settings: { hostConfigDiscovery: 'off', customFlag: true },
      mcpServers: { files: { command: 'files-mcp' } },
    }, null, 2)}\n`)

    await upsertCodingAgentMcpServer('pi', 'web', { url: 'https://example.com/mcp' })
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      settings: { hostConfigDiscovery: 'off', customFlag: true },
      mcpServers: {
        files: { command: 'files-mcp' },
        web: { url: 'https://example.com/mcp' },
      },
    })

    writeFileSync(path, '{ "mcpServers": ')
    await expect(upsertCodingAgentMcpServer('pi', 'unsafe', { command: 'unsafe' }))
      .rejects.toThrow('invalid JSON')
    expect(readFileSync(path, 'utf-8')).toBe('{ "mcpServers": ')
  })

  it.each([
    ['codex', '.codex'],
    ['grok', '.grok'],
  ] as const)('manages %s TOML and preserves non-MCP sections', async (agentId, directory) => {
    const home = makeHome()
    const path = join(home, directory, 'config.toml')
    mkdirSync(join(home, directory), { recursive: true })
    writeFileSync(path, [
      'model = "example-model"',
      '',
      '[features]',
      'web_search = true',
      '',
      '[mcp_servers."docs.search"]',
      'command = "node"',
      'args = ["docs.mjs"]',
      '',
      '[mcp_servers."docs.search".http_headers]',
      '"X-Mode" = "safe"',
      '',
    ].join('\n'))

    await upsertCodingAgentMcpServer(agentId, 'remote-tools', {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer test-value' },
      enabled: true,
    })
    await removeCodingAgentMcpServer(agentId, 'docs.search')

    const persisted = readFileSync(path, 'utf-8')
    expect(persisted).toContain('model = "example-model"')
    expect(persisted).toContain('[features]')
    expect(persisted).toContain('web_search = true')
    expect(persisted).toContain('[mcp_servers.remote-tools]')
    expect(persisted).toContain('[mcp_servers.remote-tools.http_headers]')
    expect(persisted).not.toContain('[mcp_servers."docs.search"]')
    expect(persisted).not.toContain('[mcp_servers.hermes-studio-api]')
  })

  it('keeps Studio-managed servers read-only and directly tests custom servers', async () => {
    const home = makeHome()
    expect(existsSync(join(home, '.claude', 'mcp.json'))).toBe(false)

    await expect(removeCodingAgentMcpServer('claude-code', 'hermes-studio-api'))
      .rejects.toThrow('read-only')
    await expect(upsertCodingAgentMcpServer('claude-code', 'hermes-studio-api', { command: 'replacement' }))
      .rejects.toThrow('read-only')

    await upsertCodingAgentMcpServer('claude-code', 'custom', { command: 'custom-mcp' })
    await expect(testCodingAgentMcpServer('claude-code', 'custom')).resolves.toEqual({
      ok: true,
      tools: ['custom_tool'],
    })
  })
})
