import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getCodingAgentConfigFileDefinitions,
  readCodingAgentConfigFile,
  writeCodingAgentConfigFile,
} from '../../packages/server/src/bootstrap/coding-agents'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-opencode-config-editor-'))
  homes.push(home)
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = home
  return home
}

afterEach(() => {
  delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('OpenCode config editor aliases', () => {
  it('exposes canonical memory, MCP, and settings keys over native OpenCode files', () => {
    makeHome()
    const definitions = getCodingAgentConfigFileDefinitions('opencode')

    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'memory', path: '~/.config/opencode/AGENTS.md' }),
      expect.objectContaining({ key: 'mcp', path: '~/.config/opencode/opencode.json' }),
      expect.objectContaining({ key: 'settings', path: '~/.config/opencode/opencode.json' }),
    ]))
  })

  it('keeps MCP configuration out of the settings editor and preserves it on save', async () => {
    const home = makeHome()
    const directory = join(home, '.config', 'opencode')
    const path = join(directory, 'opencode.json')
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      theme: 'system',
      model: 'native/model',
      mcp: {
        docs: { type: 'remote', url: 'https://example.com/mcp', enabled: true },
      },
    }, null, 2)}\n`)

    const settings = await readCodingAgentConfigFile('opencode', 'settings')
    expect(JSON.parse(settings.content)).toEqual({
      theme: 'system',
      model: 'native/model',
    })

    await writeCodingAgentConfigFile('opencode', 'settings', `${JSON.stringify({
      theme: 'dark',
      share: 'disabled',
      mcp: { unsafe: { type: 'local', command: ['unsafe'] } },
    }, null, 2)}\n`)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      theme: 'dark',
      share: 'disabled',
      mcp: {
        docs: { type: 'remote', url: 'https://example.com/mcp', enabled: true },
      },
    })
  })

  it('uses the canonical memory alias without creating a second file', async () => {
    const home = makeHome()
    const memory = await writeCodingAgentConfigFile('opencode', 'memory', 'Remember this.\n')

    expect(memory.path).toBe('~/.config/opencode/AGENTS.md')
    expect(readFileSync(join(home, '.config', 'opencode', 'AGENTS.md'), 'utf8')).toBe('Remember this.\n')
    expect(existsSync(join(home, '.config', 'opencode', 'memory.md'))).toBe(false)
  })
})
