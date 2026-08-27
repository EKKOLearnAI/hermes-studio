import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetAgentStatusRegistryForTests,
  updateAgentStatus,
} from '../../packages/server/src/modules/studio/public/agent-status-registry'
import {
  AGENT_NOT_INSTALLED,
  assertAgentAvailable,
  resolveAgentStatusId,
} from '../../packages/server/src/modules/studio/services/agent-availability'

describe('Agent availability validation', () => {
  beforeEach(resetAgentStatusRegistryForTests)

  it('normalizes group-chat and workflow Agent aliases', () => {
    expect(resolveAgentStatusId('ekko')).toBe('ekko-agent')
    expect(resolveAgentStatusId('claude')).toBe('claude-code')
    expect(resolveAgentStatusId('claude-code')).toBe('claude-code')
  })

  it('rejects unavailable Agents with a stable conflict code', () => {
    expect(() => assertAgentAvailable('codex')).toThrow('Codex is not installed')

    try {
      assertAgentAvailable('codex')
    } catch (error: any) {
      expect(error).toMatchObject({ status: 409, code: AGENT_NOT_INSTALLED, agent: 'codex' })
    }

    updateAgentStatus('codex', {
      installed: true,
      source: 'user-cli',
      path: '/usr/local/bin/codex',
    })
    expect(assertAgentAvailable('codex')).toBe('codex')
    expect(assertAgentAvailable('ekko')).toBe('ekko-agent')
  })

  it('validates every workflow node before execution', async () => {
    const { assertWorkflowAgentDependencies } = await import(
      '../../packages/server/src/modules/studio/services/workflow/manager'
    )
    const nodes = [{
      id: 'node-1',
      type: 'agent',
      data: {
        title: 'Reviewer',
        agent: 'codex',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        reasoningEffort: '',
        input: 'Review',
        skills: [],
        images: [],
        approvalRequired: false,
        orchestration: { join: 'all' as const },
      },
    }]

    expect(() => assertWorkflowAgentDependencies(nodes)).toThrow('Codex is not installed')
    updateAgentStatus('codex', { installed: true, source: 'user-cli', path: '/usr/local/bin/codex' })
    expect(() => assertWorkflowAgentDependencies(nodes)).not.toThrow()
  })
})
