import { delimiter, join } from 'path'
import { homedir } from 'os'
import { describe, expect, it } from 'vitest'
import {
  augmentBridgePath,
  mcpCliPathPrefixes,
  prependPathEntries,
} from '../../packages/server/src/services/hermes/agent-bridge/bridge-path'
import { buildAgentBridgeProcessEnv } from '../../packages/server/src/services/hermes/agent-bridge/manager'

describe('agent bridge PATH augmentation', () => {
  it('prepends MCP CLI prefixes without dropping existing entries', () => {
    const merged = prependPathEntries('/usr/bin:/bin', ['/Users/test/.npm-global/bin', '/usr/bin'])
    expect(merged.startsWith('/Users/test/.npm-global/bin')).toBe(true)
    expect(merged).toContain('/usr/bin')
    expect(merged).toContain('/bin')
    expect(merged.split(delimiter).filter(entry => entry === '/usr/bin')).toHaveLength(1)
  })

  it('includes npm-global and local bin in default prefix list', () => {
    const prefixes = mcpCliPathPrefixes('/Users/test')
    expect(prefixes).toContain('/Users/test/.npm-global/bin')
    expect(prefixes).toContain('/Users/test/.local/bin')
  })

  it('augments a stripped desktop-style PATH for MCP stdio commands', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin' }
    const augmented = augmentBridgePath(env, '/Users/test')
    expect(augmented).toContain('/Users/test/.npm-global/bin')
    expect(augmented).toContain('/usr/bin')
  })

  it('buildAgentBridgeProcessEnv injects augmented PATH for bridge workers', () => {
    const previousPath = process.env.PATH
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin'
    try {
      const env = buildAgentBridgeProcessEnv('ipc:///tmp/hermes-agent-bridge.sock', '/Users/test/.hermes', undefined)
      expect(env.PATH).toContain(join(homedir(), '.npm-global', 'bin'))
      expect(env.PATH).toContain('/usr/bin')
      expect(env.HERMES_AGENT_BRIDGE_ENDPOINT).toBe('ipc:///tmp/hermes-agent-bridge.sock')
      expect(env.HERMES_HOME).toBe('/Users/test/.hermes')
    } finally {
      process.env.PATH = previousPath
    }
  })
})
