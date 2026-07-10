import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const chatRunMock = vi.hoisted(() => ({
  runAndWait: vi.fn(),
  abortSession: vi.fn(),
}))

const databaseState = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => databaseState.db,
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: { appHome: databaseState.appHome },
}))

vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: () => chatRunMock,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/db/hermes/session-store')>()
  return {
    ...actual,
    getSession: vi.fn(() => null),
    getSessionDetail: vi.fn((sessionId: string) => ({
      messages: [{ role: 'assistant', content: `output:${sessionId}` }],
    })),
    deleteSession: vi.fn(),
  }
})

describe('workflow manager', () => {
  let root = ''

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-workflow-manager-'))
    databaseState.appHome = join(root, 'home')
    databaseState.db = new DatabaseSync(join(root, 'workflow-manager.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    databaseState.db?.close()
    databaseState.db = null
    if (root) rmSync(root, { recursive: true, force: true })
  })

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

  it('requires workflow node approval only when explicitly enabled', async () => {
    const { workflowNodeRequiresApproval } = await import('../../packages/server/src/services/workflow-manager')

    expect(workflowNodeRequiresApproval({ data: { approvalRequired: true } })).toBe(true)
    expect(workflowNodeRequiresApproval({ data: { approvalRequired: false } })).toBe(false)
    expect(workflowNodeRequiresApproval({ data: {} })).toBe(false)
  })

  it('propagates a node execution policy into a fresh workflow run', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'plan complete' })

    const workflow = manager.create({
      name: `Restricted node ${Date.now()}`,
      profile: 'default',
      nodes: [{
        id: 'plan',
        type: 'agent',
        data: {
          title: 'Plan',
          agent: 'hermes',
          input: 'Read and plan only',
          executionPolicy: { allowedToolsets: ['safe'] },
        },
      }],
      edges: [],
    })

    try {
      await expect(manager.runNow(workflow.id)).resolves.toMatchObject({
        run: { status: 'completed' },
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
        source: 'workflow',
        session_source: 'workflow',
        workflow_id: workflow.id,
        workflow_node_id: 'plan',
        execution_policy: { allowedToolsets: ['safe'] },
      }), expect.any(Object))
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('preserves an explicit zero-tool policy instead of falling back to profile tools', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'review complete' })
    const workflow = manager.create({
      name: `Zero-tool node ${Date.now()}`,
      profile: 'default',
      nodes: [{
        id: 'review',
        type: 'agent',
        data: {
          title: 'Review',
          agent: 'hermes',
          input: 'Review without tools',
          executionPolicy: { allowedToolsets: [] },
        },
      }],
      edges: [],
    })

    try {
      await manager.runNow(workflow.id)
      expect(chatRunMock.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
        execution_policy: { allowedToolsets: [] },
      }), expect.any(Object))
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('rejects a scoped coding-agent node policy that this runtime cannot enforce', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    const workflow = manager.create({
      name: `Unsupported scoped policy ${Date.now()}`,
      profile: 'default',
      nodes: [{
        id: 'code',
        type: 'agent',
        data: {
          title: 'Code',
          agent: 'codex',
          input: 'Implement',
          executionPolicy: { allowedToolsets: ['safe'] },
        },
      }],
      edges: [],
    })

    try {
      await expect(manager.runNow(workflow.id)).resolves.toMatchObject({
        run: { status: 'failed', error: expect.stringContaining('Hermes nodes only') },
      })
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('pauses downstream nodes until an approval-required node is approved', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const workflow = manager.create({
      name: `Approval gate ${Date.now()}`,
      profile: 'default',
      nodes: [
        {
          id: 'first',
          type: 'agent',
          data: {
            title: 'First',
            agent: 'hermes',
            input: 'first task',
            approvalRequired: true,
          },
        },
        {
          id: 'second',
          type: 'agent',
          data: {
            title: 'Second',
            agent: 'hermes',
            input: 'second task',
          },
        },
      ],
      edges: [{ id: 'first-second', source: 'first', target: 'second' }],
    })

    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => {
        expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.first).toBe('pending_approval')
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)

      const runId = manager.getRuntimeStatus(workflow.id).runId
      expect(runId).toBeTruthy()
      expect(manager.approveNode(workflow.id, runId!, 'first', true)).toBe(true)

      await expect(runPromise).resolves.toMatchObject({
        run: { status: 'completed' },
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.second).toBe('completed')
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('keeps parallel pending approvals open after one node is rejected', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const workflow = manager.create({
      name: `Parallel approvals ${Date.now()}`,
      profile: 'default',
      nodes: [
        {
          id: 'first',
          type: 'agent',
          data: { title: 'First', agent: 'hermes', input: 'first task', approvalRequired: true },
        },
        {
          id: 'second',
          type: 'agent',
          data: { title: 'Second', agent: 'hermes', input: 'second task', approvalRequired: true },
        },
        {
          id: 'join',
          type: 'agent',
          data: { title: 'Join', agent: 'hermes', input: 'join task' },
        },
      ],
      edges: [
        { id: 'first-join', source: 'first', target: 'join' },
        { id: 'second-join', source: 'second', target: 'join' },
      ],
    })

    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => {
        const statuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
        expect(statuses.first).toBe('pending_approval')
        expect(statuses.second).toBe('pending_approval')
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)

      const runId = manager.getRuntimeStatus(workflow.id).runId
      expect(runId).toBeTruthy()
      expect(manager.approveNode(workflow.id, runId!, 'first', false)).toBe(true)
      await vi.waitFor(() => {
        const statuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
        expect(statuses.first).toBe('approval_rejected')
        expect(statuses.second).toBe('pending_approval')
      })

      expect(manager.approveNode(workflow.id, runId!, 'second', true)).toBe(true)
      await expect(runPromise).resolves.toMatchObject({
        run: { status: 'failed' },
      })
      const finalStatuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
      expect(finalStatuses.first).toBe('approval_rejected')
      expect(finalStatuses.second).toBe('completed')
      expect(finalStatuses.join).toBe('canceled')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('reruns incomplete external upstream dependencies for downstream joins', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const {
      createWorkflowRun,
      createWorkflowRunNodeSession,
      listWorkflowRunNodeSessions,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const snapshotNodes = [
      { id: 'entry-a', type: 'agent', data: { title: 'Entry A', agent: 'hermes', input: 'a' } },
      { id: 'entry-b', type: 'agent', data: { title: 'Entry B', agent: 'hermes', input: 'b' } },
      { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join' } },
    ]
    const snapshotEdges = [
      { id: 'entry-a-join', source: 'entry-a', target: 'join' },
      { id: 'entry-b-join', source: 'entry-b', target: 'join' },
    ]
    const workflow = manager.create({
      name: `Rerun dependencies ${Date.now()}`,
      profile: 'default',
      nodes: snapshotNodes,
      edges: snapshotEdges,
    })
    const run = createWorkflowRun({
      workflow_id: workflow.id,
      profile: 'default',
      status: 'canceled',
      snapshot_nodes: snapshotNodes,
      snapshot_edges: snapshotEdges,
      started_at: Date.now(),
    })
    for (const [sequence, nodeId] of ['entry-a', 'entry-b', 'join'].entries()) {
      createWorkflowRunNodeSession({
        run_id: run.id,
        workflow_id: workflow.id,
        node_id: nodeId,
        session_id: `canceled-${nodeId}`,
        profile: 'default',
        agent: 'hermes',
        status: 'canceled',
        sequence,
        started_at: Date.now(),
        finished_at: Date.now(),
      })
    }

    try {
      await expect(manager.rerunFromNode(workflow.id, run.id, 'entry-a')).resolves.toMatchObject({
        run: { status: 'completed' },
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(listWorkflowRunNodeSessions(run.id).map(session => [session.node_id, session.status])).toEqual([
        ['entry-a', 'completed'],
        ['entry-b', 'completed'],
        ['join', 'completed'],
      ])
    } finally {
      await manager.delete(workflow.id)
    }
  })
})
