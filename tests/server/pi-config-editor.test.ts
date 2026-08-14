import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodingAgentConfigFile } from '../../packages/server/src/services/coding-agents'

const homes: string[] = []

afterEach(() => {
  delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-pi-config-editor-'))
  homes.push(home)
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = home
  return home
}

describe('Pi config editor defaults', () => {
  it('materializes minimal user configuration without runtime Studio servers', async () => {
    const home = makeHome()

    const settings = await readCodingAgentConfigFile('pi', 'settings', { profile: 'reviewer' })
    const mcp = await readCodingAgentConfigFile('pi', 'mcp', { profile: 'reviewer' })

    expect(settings.exists).toBe(true)
    expect(settings.content).toContain('pi-mcp-adapter')
    expect(mcp.exists).toBe(true)
    expect(JSON.parse(mcp.content)).toEqual({
      mcpServers: {},
    })
    expect(existsSync(join(home, '.pi', 'agent', 'settings.json'))).toBe(true)
    expect(readFileSync(join(home, '.pi', 'agent', 'mcp.json'), 'utf-8')).toBe(mcp.content)
  })

  it('removes managed Studio servers while preserving user MCP entries', async () => {
    const home = makeHome()
    const mcpPath = join(home, '.pi', 'agent', 'mcp.json')
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    writeFileSync(mcpPath, `${JSON.stringify({
      settings: {
        hostConfigDiscovery: 'off',
        directTools: true,
        agentPluginPaths: ['./plugins'],
      },
      mcpServers: {
        user_docs: { url: 'https://docs.example.com/mcp' },
        'hermes-studio-api': {
          command: 'stale-managed',
          env: { HERMES_WEB_UI_MANAGED_MCP: '1' },
        },
      },
    }, null, 2)}\n`)

    const mcp = await readCodingAgentConfigFile('pi', 'mcp')

    expect(JSON.parse(mcp.content)).toEqual({
      settings: {
        agentPluginPaths: ['./plugins'],
      },
      mcpServers: {
        user_docs: { url: 'https://docs.example.com/mcp' },
      },
    })
    expect(readFileSync(mcpPath, 'utf-8')).toBe(mcp.content)
  })

  it('does not overwrite invalid user JSON while it is being corrected', async () => {
    const home = makeHome()
    const mcpPath = join(home, '.pi', 'agent', 'mcp.json')
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    writeFileSync(mcpPath, '{ "mcpServers": ')

    const mcp = await readCodingAgentConfigFile('pi', 'mcp')

    expect(mcp.content).toBe('{ "mcpServers": ')
    expect(readFileSync(mcpPath, 'utf-8')).toBe(mcp.content)
  })

  it('leaves optional user files absent and keeps runtime-only files out of the user config directory', async () => {
    const home = makeHome()

    const auth = await readCodingAgentConfigFile('pi', 'auth')
    const agents = await readCodingAgentConfigFile('pi', 'agents')

    expect(auth).toMatchObject({ exists: false, content: '', path: '~/.pi/agent/auth.json' })
    expect(agents).toMatchObject({ exists: false, content: '', path: '~/.pi/agent/AGENTS.md' })
    expect(existsSync(join(home, '.pi', 'agent', 'models.json'))).toBe(false)
    expect(existsSync(join(home, '.pi', 'agent', 'APPEND_SYSTEM.md'))).toBe(false)
  })
})
