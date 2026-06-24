import { describe, expect, it } from 'vitest'

describe('workflow manager', () => {
  it('returns a server-wide singleton instance', async () => {
    const { WorkflowManager, getWorkflowManager } = await import('../../packages/server/src/services/workflow-manager')

    const first = getWorkflowManager()
    const second = getWorkflowManager()

    expect(first).toBe(second)
    expect(first).toBeInstanceOf(WorkflowManager)
  })

  it('stores and emits workflow runtime status updates', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const updates: unknown[] = []
    const dispose = manager.onRuntimeStatus(status => updates.push(status))

    const status = manager.setRuntimeStatus('workflow-1', {
      status: 'running',
      runId: 'run-1',
      startedAt: 123,
    })

    expect(status).toMatchObject({
      workflowId: 'workflow-1',
      status: 'running',
      runId: 'run-1',
      startedAt: 123,
      completedAt: null,
      error: null,
    })
    expect(manager.getRuntimeStatus('workflow-1')).toBe(status)
    expect(manager.listRuntimeStatuses()).toEqual([status])
    expect(updates).toEqual([status])

    dispose()
    manager.setRuntimeStatus('workflow-1', { status: 'completed', completedAt: 456 })
    expect(updates).toEqual([status])
  })

  it('maps workflow node agents to the existing run backends', async () => {
    const { resolveWorkflowNodeRunTarget } = await import('../../packages/server/src/services/workflow-manager')

    expect(resolveWorkflowNodeRunTarget('hermes')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'hermes',
    })
    expect(resolveWorkflowNodeRunTarget('claude-code')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'claude',
      codingAgentId: 'claude-code',
    })
    expect(resolveWorkflowNodeRunTarget('codex')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'codex',
      codingAgentId: 'codex',
    })
    expect(resolveWorkflowNodeRunTarget('unknown')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'hermes',
    })
  })
})
