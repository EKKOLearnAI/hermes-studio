import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDshMcpServers, updateDshMcpServer } from '../../packages/server/src/modules/coding-agents/services/dsh/config'
import {
  disableTomlMcpServers,
  isolateUnhealthyRuntimeMcpServers,
  type CodingAgentMcpProbeResult,
} from '../../packages/server/src/modules/coding-agents/services/mcp-runtime-isolation'

const roots: string[] = []

function temporaryFile(name: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-mcp-runtime-isolation-'))
  roots.push(root)
  const path = join(root, name)
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('coding Agent MCP runtime isolation', () => {
  it('disables unhealthy DSH MCP rows while preserving native expressions and managed servers', async () => {
    let content = '- insert:\n    - id: dynamic\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: dynamic\n        command: !!js process.env.MCP_COMMAND\n'
    content = updateDshMcpServer(content, 'broken', { command: 'missing' })
    content = updateDshMcpServer(content, 'ekko-studio-api', { command: 'node' })
    const path = temporaryFile('cordis.patch.yml', content)
    const probe = vi.fn(async () => ({ ok: false, error: 'missing command' }))
    await expect(isolateUnhealthyRuntimeMcpServers('dsh', path, { probe })).resolves.toEqual(['broken'])
    const updated = readFileSync(path, 'utf8')
    expect(updated).toContain('!!js process.env.MCP_COMMAND')
    expect(readDshMcpServers(updated).get('broken')?.enabled).toBe(false)
    expect(readDshMcpServers(updated).get('ekko-studio-api')?.enabled).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('removes only unhealthy custom servers from a JSON runtime copy', async () => {
    const path = temporaryFile('mcp.json', `${JSON.stringify({
      mcpServers: {
        healthy: { command: 'healthy-command' },
        unhealthy: { url: 'https://unhealthy.example/mcp' },
        disabled: { command: 'disabled-command', enabled: false },
        'ekko-studio-api': {
          command: 'managed-command',
          env: { HERMES_WEB_UI_MANAGED_MCP: '1' },
        },
      },
    }, null, 2)}\n`)
    const probe = vi.fn(async (config: Record<string, any>): Promise<CodingAgentMcpProbeResult> => (
      config.command === 'healthy-command'
        ? { ok: true, tools: ['search'] }
        : { ok: false, error: 'HTTP 401' }
    ))

    await expect(isolateUnhealthyRuntimeMcpServers('claude-code', path, { probe }))
      .resolves.toEqual(['unhealthy'])

    const runtime = JSON.parse(readFileSync(path, 'utf-8'))
    expect(runtime.mcpServers.healthy).toEqual({ command: 'healthy-command' })
    expect(runtime.mcpServers.unhealthy).toBeUndefined()
    expect(runtime.mcpServers.disabled).toEqual({ command: 'disabled-command', enabled: false })
    expect(runtime.mcpServers['ekko-studio-api']).toBeDefined()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('disables an unhealthy custom TOML server only in the runtime copy', async () => {
    const path = temporaryFile('config.toml', [
      'model = "test"',
      '',
      '[mcp_servers.healthy]',
      'command = "healthy-command"',
      '',
      '[mcp_servers."needs.auth"]',
      'url = "https://unhealthy.example/mcp"',
      '',
      '[mcp_servers."needs.auth".http_headers]',
      'Authorization = "Bearer test-only"',
      '',
      '[mcp_servers.disabled]',
      'command = "disabled-command"',
      'enabled = false',
      '',
      '[mcp_servers.ekko-studio-api]',
      'command = "managed-command"',
      'env = { HERMES_WEB_UI_MANAGED_MCP = "1" }',
      '',
    ].join('\n'))
    const original = readFileSync(path, 'utf-8')
    const probe = vi.fn(async (config: Record<string, any>): Promise<CodingAgentMcpProbeResult> => (
      config.command === 'healthy-command'
        ? { ok: true, tools: ['search'] }
        : { ok: false, error: 'HTTP 401' }
    ))

    await expect(isolateUnhealthyRuntimeMcpServers('codex', path, { probe }))
      .resolves.toEqual(['needs.auth'])

    const runtime = readFileSync(path, 'utf-8')
    expect(runtime).toContain('[mcp_servers.healthy]\ncommand = "healthy-command"')
    expect(runtime).toContain('[mcp_servers."needs.auth"]\nurl = "https://unhealthy.example/mcp"\nenabled = false')
    expect(runtime).toContain('[mcp_servers."needs.auth".http_headers]\nAuthorization = "Bearer test-only"')
    expect(runtime).toContain('[mcp_servers.disabled]\ncommand = "disabled-command"\nenabled = false')
    expect(runtime).toContain('[mcp_servers.ekko-studio-api]\ncommand = "managed-command"')
    expect(runtime).not.toBe(original)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('removes unhealthy OpenCode MCP servers while preserving its JSON schema', async () => {
    const path = temporaryFile('opencode.json', `${JSON.stringify({
      model: 'native/model',
      mcp: {
        healthy: { type: 'local', command: ['healthy-command', '--stdio'], environment: { TOKEN: 'test' } },
        unhealthy: { type: 'remote', url: 'https://unhealthy.example/mcp' },
        disabled: { type: 'local', command: ['disabled-command'], enabled: false },
        'ekko-studio-api': { type: 'local', command: ['managed-command'], enabled: true },
      },
    }, null, 2)}\n`)
    const probe = vi.fn(async (config: Record<string, any>): Promise<CodingAgentMcpProbeResult> => (
      config.command === 'healthy-command'
        ? { ok: true, tools: ['search'] }
        : { ok: false, error: 'HTTP 401' }
    ))

    await expect(isolateUnhealthyRuntimeMcpServers('opencode', path, { probe }))
      .resolves.toEqual(['unhealthy'])

    const runtime = JSON.parse(readFileSync(path, 'utf-8'))
    expect(runtime.model).toBe('native/model')
    expect(runtime.mcp.healthy.command).toEqual(['healthy-command', '--stdio'])
    expect(runtime.mcp.unhealthy).toBeUndefined()
    expect(runtime.mcp.disabled).toBeDefined()
    expect(runtime.mcp['ekko-studio-api']).toBeDefined()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      command: 'healthy-command',
      args: ['--stdio'],
      env: { TOKEN: 'test' },
    }))
  })

  it('replaces an existing enabled value instead of duplicating it', () => {
    const updated = disableTomlMcpServers([
      '[mcp_servers.docs]',
      'url = "https://docs.example/mcp"',
      'enabled = true',
      '',
    ].join('\n'), new Set(['docs']))

    expect(updated.match(/^enabled = false$/gm)).toHaveLength(1)
    expect(updated).not.toContain('enabled = true')
  })
})
