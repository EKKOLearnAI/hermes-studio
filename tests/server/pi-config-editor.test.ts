import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
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
  it('materializes the managed Pi settings and four Studio MCP servers', async () => {
    const home = makeHome()

    const settings = await readCodingAgentConfigFile('pi', 'settings', { profile: 'reviewer' })
    const mcp = await readCodingAgentConfigFile('pi', 'mcp', { profile: 'reviewer' })

    expect(settings.exists).toBe(true)
    expect(settings.content).toContain('pi-mcp-adapter')
    expect(mcp.exists).toBe(true)
    expect(mcp.content).toContain('"hermes-studio-api"')
    expect(mcp.content).toContain('"hermes-studio-browser"')
    expect(mcp.content).toContain('"hermes-studio-devices"')
    expect(mcp.content).toContain('"hermes-studio-use"')
    expect(mcp.content).toContain('"HERMES_WEB_UI_PROFILE": "reviewer"')
    expect(existsSync(join(home, '.pi', 'agent', 'settings.json'))).toBe(true)
    expect(readFileSync(join(home, '.pi', 'agent', 'mcp.json'), 'utf-8')).toBe(mcp.content)
  })

  it('materializes valid non-empty model and prompt files', async () => {
    makeHome()

    const models = await readCodingAgentConfigFile('pi', 'models')
    const prompt = await readCodingAgentConfigFile('pi', 'prompt')

    expect(JSON.parse(models.content)).toEqual({ providers: {} })
    expect(prompt.content.trim().length).toBeGreaterThan(0)
  })
})
