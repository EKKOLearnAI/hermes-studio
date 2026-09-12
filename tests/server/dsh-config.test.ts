import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { readCodingAgentConfigFile, writeCodingAgentConfigFile, versionGte } from '../../packages/server/src/bootstrap/coding-agents'
import { assertDshMcpProbeIsLiteral, readDshMcpServers, updateDshMcpServer } from '../../packages/server/src/modules/coding-agents/services/dsh/config'

let home: string | undefined
const previousHome = process.env.HERMES_CODING_AGENT_GLOBAL_HOME
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
  if (previousHome === undefined) delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = previousHome
})

describe('DSH native configuration', () => {
  it('reads defaults and saves native settings and instructions independently', async () => {
    home = mkdtempSync(join(tmpdir(), 'studio-dsh-config-'))
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = home
    expect((await readCodingAgentConfigFile('dsh', 'settings')).content).toBe('{}\n')
    expect((await readCodingAgentConfigFile('dsh', 'mcp')).content).toBe('[]\n')
    await writeCodingAgentConfigFile('dsh', 'settings', 'model: deepseek-chat\n')
    await writeCodingAgentConfigFile('dsh', 'memory', 'Project instructions\n')
    await expect(writeCodingAgentConfigFile('dsh', 'settings', '- bad\n')).rejects.toThrow('mapping')
    await expect(writeCodingAgentConfigFile('dsh', 'mcp', 'mcpServers: {}')).rejects.toThrow('sequence')
    expect(readFileSync(join(home, '.dsh/settings.yaml'), 'utf8')).toBe('model: deepseek-chat\n')
    expect(readFileSync(join(home, '.dsh/AGENTS.md'), 'utf8')).toBe('Project instructions\n')
  })

  it('inserts, edits, disables and removes MCP plugins while preserving Cordis expressions', () => {
    const initial = `# keep plugin configuration\n- id: other\n  config:\n    secret: !!js process.env.TEST_SECRET\n`
    const inserted = updateDshMcpServer(initial, 'docs', { command: 'node', args: ['docs.mjs'], env: { MODE: 'test' } })
    const rows = parseDocument(inserted, { logLevel: 'silent' }).toJS()
    expect(rows[1].insert[0]).toMatchObject({ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'docs', transport: 'stdio' } })
    const edited = updateDshMcpServer(inserted, 'docs', { url: 'https://example.com/mcp', enabled: false })
    expect(readDshMcpServers(edited).get('docs')).toEqual({ transport: 'streamable-http', url: 'https://example.com/mcp', enabled: false })
    expect(edited).toContain('# keep plugin configuration')
    expect(edited).toContain('!!js process.env.TEST_SECRET')
    const removed = updateDshMcpServer(edited, 'docs', null)
    expect(readDshMcpServers(removed).size).toBe(0)
    expect(removed).toContain('!!js process.env.TEST_SECRET')
  })

  it('preserves an unchanged MCP expression and refuses to probe it as a literal', () => {
    const source = `- insert:\n    - name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: docs\n        transport: stdio\n        command: node\n        env: !!js process.env\n`
    const config = readDshMcpServers(source).get('docs')!
    const edited = updateDshMcpServer(source, 'docs', { ...config, enabled: false })
    expect(edited).toContain('!!js process.env')
    expect(() => assertDshMcpProbeIsLiteral(edited, 'docs')).toThrow('JavaScript expressions')
  })

  it('resolves YAML aliases for display and preserves their anchors during edits', () => {
    const source = `- id: defaults\n  env: &env\n    MODE: test\n- insert:\n    - name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: docs\n        command: node\n        env: *env\n`
    const config = readDshMcpServers(source).get('docs')!
    expect(config.env).toEqual({ MODE: 'test' })
    const edited = updateDshMcpServer(source, 'docs', { ...config, enabled: false })
    expect(edited).toContain('env: *env')
    expect(() => assertDshMcpProbeIsLiteral(edited, 'docs')).not.toThrow()
    const dynamic = source.replace('env: &env\n    MODE: test', 'env: &env !!js process.env')
    expect(() => assertDshMcpProbeIsLiteral(dynamic, 'docs')).toThrow('JavaScript expressions')
  })

  it.each([
    ['bad.name', { command: 'node' }],
    ['docs', { type: 'sse', url: 'https://example.com/sse' }],
    ['docs', { transport: 'stdio', url: 'https://example.com/mcp' }],
    ['docs', { command: 'node', url: 'https://example.com/mcp' }],
  ])('rejects unsupported MCP configuration: %s %j', (name, config) => {
    expect(() => updateDshMcpServer('[]', name as string, config as any)).toThrow()
  })

  it.each([
    ['0.1.5-rc.1', '0.1.5-rc.2', false],
    ['dsh 0.1.5-rc.10', '0.1.5-rc.2', true],
    ['0.1.5-rc.2', '0.1.5', false],
    ['0.1.5', '0.1.5-rc.2', true],
    ['0.1.5-rc.2', '0.1.5-rc.2', true],
    ['0.1.6-rc.1', '0.1.5', true],
  ])('compares DSH prereleases %s >= %s', (installed, latest, result) => {
    expect(versionGte(installed, latest, true)).toBe(result)
  })
})
