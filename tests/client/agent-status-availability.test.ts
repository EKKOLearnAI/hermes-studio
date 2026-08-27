// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  isAgentStatusAvailable,
  resolveAgentStatusId,
  type AgentStatusSnapshot,
} from '../../packages/client/src/api/agent-status'

function snapshot(): AgentStatusSnapshot {
  return {
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    agents: [
      { id: 'hermes', installed: false, source: 'not-installed', path: '', version: '' },
      { id: 'ekko-agent', installed: true, source: 'built-in', path: '', version: '1.0.0' },
      { id: 'claude-code', installed: false, source: 'not-installed', path: '', version: '' },
      { id: 'codex', installed: true, source: 'user-cli', path: '/usr/local/bin/codex', version: '1.0.0' },
      { id: 'pi', installed: false, source: 'not-installed', path: '', version: '' },
    ],
  }
}

describe('Agent status availability', () => {
  it('normalizes group-chat and workflow Agent aliases', () => {
    expect(resolveAgentStatusId('ekko')).toBe('ekko-agent')
    expect(resolveAgentStatusId('claude')).toBe('claude-code')
    expect(resolveAgentStatusId('codex')).toBe('codex')
  })

  it('only exposes Agents that the server inventory marks installed', () => {
    const status = snapshot()

    expect(isAgentStatusAvailable(status, 'hermes')).toBe(false)
    expect(isAgentStatusAvailable(status, 'ekko')).toBe(true)
    expect(isAgentStatusAvailable(status, 'claude-code')).toBe(false)
    expect(isAgentStatusAvailable(status, 'codex')).toBe(true)
  })
})
