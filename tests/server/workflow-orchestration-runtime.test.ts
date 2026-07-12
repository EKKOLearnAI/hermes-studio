import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null, appHome: '' }))
const chatRunMock = vi.hoisted(() => ({ runAndWait: vi.fn(), abortSession: vi.fn() }))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(), jsonGet: vi.fn(), jsonGetAll: vi.fn(() => ({})), jsonSet: vi.fn(),
}))
vi.mock('../../packages/server/src/config', () => ({ config: { appHome: state.appHome } }))
vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({ getChatRunServer: () => chatRunMock }))
vi.mock('../../packages/server/src/db/hermes/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/db/hermes/session-store')>()
  return { ...actual, getSession: vi.fn(() => null), getSessionDetail: vi.fn(() => ({ messages: [] })), deleteSession: vi.fn() }
})

describe('workflow orchestration runtime', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-workflow-runtime-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
  })
  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('counts pending approval time against the total deadline', async () => {
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'needs approval' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Approval deadline', profile: 'default',
      nodes: [{ id: 'approval', type: 'agent', data: {
        title: 'Approval', agent: 'hermes', input: 'approve', approvalRequired: true,
      } }],
      edges: [],
    })
    const result = await Promise.race([
      manager.runNow(workflow.id, { totalTimeoutMs: 100 }),
      new Promise<'still_waiting'>(resolve => setTimeout(() => resolve('still_waiting'), 200)),
    ])
    expect(result).not.toBe('still_waiting')
    expect(result).toMatchObject({
      run: { status: 'failed', error: expect.stringContaining('workflow_timeout') },
      nodeSessions: [expect.objectContaining({ status: 'failed', error: 'workflow_timeout' })],
    })
    const completed = result as Exclude<typeof result, 'still_waiting'>
    expect(manager.approveNode(workflow.id, completed.run.id, 'approval', true)).toBe(false)
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
  })

  it('aborts every active parallel session when the run is stopped', async () => {
    const pending: Array<(value: { ok: false; error: string }) => void> = []
    chatRunMock.runAndWait.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    chatRunMock.abortSession.mockImplementation(async () => {
      pending.shift()?.({ ok: false, error: 'user_cancelled' })
    })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Parallel stop', profile: 'default',
      nodes: [
        { id: 'first', type: 'agent', data: { title: 'First', agent: 'hermes', input: 'first' } },
        { id: 'second', type: 'agent', data: { title: 'Second', agent: 'hermes', input: 'second' } },
      ],
      edges: [],
    })
    const runPromise = manager.runNow(workflow.id)
    await vi.waitFor(() => expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2))
    const runId = manager.getRuntimeStatus(workflow.id).runId!
    await manager.stopRun(workflow.id, runId, 'user_cancelled')
    expect(chatRunMock.abortSession).toHaveBeenCalledTimes(2)
    expect(chatRunMock.abortSession).toHaveBeenCalledWith(expect.any(String), 'user_cancelled')
    const result = await Promise.race([
      runPromise,
      new Promise<'still_waiting'>(resolve => setTimeout(() => resolve('still_waiting'), 100)),
    ])
    expect(result).not.toBe('still_waiting')
    expect(result).toMatchObject({ run: { status: 'canceled' } })
  })

  it('fails a running workflow when the total deadline expires', async () => {
    chatRunMock.runAndWait.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return { ok: true, output: 'late' }
    })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Total deadline', profile: 'default',
      nodes: [{ id: 'slow', type: 'agent', data: { title: 'Slow', agent: 'hermes', input: 'wait' } }],
      edges: [],
    })
    const result = await manager.runNow(workflow.id, { totalTimeoutMs: 100 })
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringContaining('workflow_timeout') })
    expect(chatRunMock.abortSession).toHaveBeenCalledWith(expect.any(String), 'workflow_timeout')
  })

  it('does not oversubscribe the execution budget across parallel ready nodes', async () => {
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Parallel execution budget', profile: 'default',
      nodes: [
        { id: 'first', type: 'agent', data: { title: 'First', agent: 'hermes', input: 'first' } },
        { id: 'second', type: 'agent', data: { title: 'Second', agent: 'hermes', input: 'second' } },
      ],
      edges: [],
    })
    const result = await manager.runNow(workflow.id, { executionBudget: 1 })
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringContaining('execution_budget_exceeded') })
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    expect(result.nodeSessions).toHaveLength(1)
  })

  it('fails before creating a session beyond the execution budget', async () => {
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Execution budget', profile: 'default',
      nodes: [
        { id: 'first', type: 'agent', data: { title: 'First', agent: 'hermes', input: 'first' } },
        { id: 'second', type: 'agent', data: { title: 'Second', agent: 'hermes', input: 'second' } },
      ],
      edges: [{ id: 'first-second', source: 'first', target: 'second' }],
    })
    const result = await manager.runNow(workflow.id, { executionBudget: 1 })
    expect(result.run).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('execution_budget_exceeded'),
      execution_budget: 1,
      total_timeout_ms: 3_600_000,
    })
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    expect(result.nodeSessions).toHaveLength(1)
  })

  it('keeps the legacy fail-fast behavior when failure is not handled', async () => {
    chatRunMock.runAndWait.mockResolvedValueOnce({ ok: false, error: 'review failed' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Unhandled failure', profile: 'default',
      nodes: [
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
      ],
      edges: [{ id: 'review-publish', source: 'review', target: 'publish' }],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run.status).toBe('failed')
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({ review: 'failed', publish: 'canceled' })
  })

  it('skips the failure handler when the source succeeds', async () => {
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: true, output: 'approved' })
      .mockResolvedValueOnce({ ok: true, output: 'published' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Success routing', profile: 'default',
      nodes: [
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'recover', type: 'agent', data: { title: 'Recover', agent: 'hermes', input: 'recover' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
      ],
      edges: [
        { id: 'review-recover', source: 'review', target: 'recover', data: { orchestration: { route: 'failure' } } },
        { id: 'review-publish', source: 'review', target: 'publish' },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run.status).toBe('completed')
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({
      review: 'completed', recover: 'skipped', publish: 'completed',
    })
  })

  it('propagates skipped branches independent of node array order', async () => {
    chatRunMock.runAndWait.mockResolvedValueOnce({ ok: true, output: 'approved' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Skipped branch order', profile: 'default',
      nodes: [
        { id: 'notify', type: 'agent', data: { title: 'Notify', agent: 'hermes', input: 'notify' } },
        { id: 'recover', type: 'agent', data: { title: 'Recover', agent: 'hermes', input: 'recover' } },
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
      ],
      edges: [
        { id: 'review-recover', source: 'review', target: 'recover', data: { orchestration: { route: 'failure' } } },
        { id: 'recover-notify', source: 'recover', target: 'notify' },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run.status).toBe('completed')
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({
      review: 'completed', recover: 'skipped', notify: 'skipped',
    })
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    expect(listWorkflowRunEdgeEvaluations(result.run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edge_id: 'recover-notify', status: 'not_taken', reason: 'source node was skipped',
      }),
    ]))
  })

  it('requires every inbound edge for the default all join mode', async () => {
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: true, output: 'approved' })
      .mockResolvedValueOnce({ ok: true, output: 'healthy' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'All join', profile: 'default',
      nodes: [
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'check', type: 'agent', data: { title: 'Check', agent: 'hermes', input: 'check' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
      ],
      edges: [
        { id: 'review-publish', source: 'review', target: 'publish' },
        { id: 'check-publish', source: 'check', target: 'publish', data: { orchestration: { route: 'failure' } } },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run.status).toBe('completed')
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.publish).toBe('skipped')
  })

  it('does not treat a failure as handled when its all-join handler is skipped', async () => {
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: false, error: 'review failed' })
      .mockResolvedValueOnce({ ok: true, output: 'healthy' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Skipped failure handler', profile: 'default',
      nodes: [
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'check', type: 'agent', data: { title: 'Check', agent: 'hermes', input: 'check' } },
        { id: 'recover', type: 'agent', data: { title: 'Recover', agent: 'hermes', input: 'recover' } },
      ],
      edges: [
        { id: 'review-recover', source: 'review', target: 'recover', data: { orchestration: { route: 'failure' } } },
        { id: 'check-recover', source: 'check', target: 'recover', data: { orchestration: { route: 'failure' } } },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringContaining('review failed') })
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.recover).toBe('skipped')
  })

  it('does not count an already running any-join target as a failure handler', async () => {
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: true, output: 'start' })
      .mockResolvedValueOnce({ ok: true, output: 'published early' })
      .mockResolvedValueOnce({ ok: false, error: 'late check failed' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Concurrent any handler', profile: 'default',
      nodes: [
        { id: 'start', type: 'agent', data: { title: 'Start', agent: 'hermes', input: 'start' } },
        { id: 'recover', type: 'agent', data: { title: 'Recover', agent: 'hermes', input: 'recover', orchestration: { joinMode: 'any' } } },
        { id: 'check', type: 'agent', data: { title: 'Check', agent: 'hermes', input: 'check' } },
      ],
      edges: [
        { id: 'start-recover', source: 'start', target: 'recover' },
        { id: 'start-check', source: 'start', target: 'check' },
        { id: 'check-recover', source: 'check', target: 'recover', data: { orchestration: { route: 'failure' } } },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringContaining('late check failed') })
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
  })

  it('runs a node with any join mode when one inbound edge is taken', async () => {
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: true, output: 'approved' })
      .mockResolvedValueOnce({ ok: true, output: 'healthy' })
      .mockResolvedValueOnce({ ok: true, output: 'published' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Any join', profile: 'default',
      nodes: [
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'check', type: 'agent', data: { title: 'Check', agent: 'hermes', input: 'check' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish', orchestration: { joinMode: 'any' } } },
      ],
      edges: [
        { id: 'review-publish', source: 'review', target: 'publish' },
        { id: 'check-publish', source: 'check', target: 'publish', data: { orchestration: { route: 'failure' } } },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run.status).toBe('completed')
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
    const publishInput = String(chatRunMock.runAndWait.mock.calls[2][0].input)
    expect(publishInput).toContain('[Upstream: Review]')
    expect(publishInput).not.toContain('[Upstream: Check]')
    expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.publish).toBe('completed')
  })

  it('fails the run when an edge condition cannot be evaluated', async () => {
    chatRunMock.runAndWait.mockResolvedValueOnce({ ok: true, output: 'not-json' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Condition error', profile: 'default',
      nodes: [
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
      ],
      edges: [{
        id: 'conditional', source: 'review', target: 'publish',
        data: { orchestration: { route: 'success', condition: { path: 'approved', operator: 'equals', value: true } } },
      }],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringMatching(/valid JSON/) })
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed orchestration before creating a run', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Invalid route', profile: 'default',
      nodes: [
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
      ],
      edges: [{ id: 'invalid', source: 'review', target: 'publish', data: { orchestration: { route: 'sometimes' } } }],
    })
    await expect(manager.runNow(workflow.id)).rejects.toThrow('workflow edge route is invalid')
    expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    const { listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    expect(listWorkflowRuns(workflow.id)).toEqual([])
  })

  it('runs an explicit failure handler and completes the workflow', async () => {
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: false, error: 'review failed' })
      .mockResolvedValueOnce({ ok: true, output: 'recovered' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Failure handler', profile: 'default',
      nodes: [
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'recover', type: 'agent', data: { title: 'Recover', agent: 'hermes', input: 'recover' } },
      ],
      edges: [{ id: 'review-recover', source: 'review', target: 'recover', data: { orchestration: { route: 'failure' } } }],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run.status).toBe('completed')
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    expect(chatRunMock.runAndWait.mock.calls[1][0].input).toContain('review failed')
    expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({ review: 'failed', recover: 'completed' })
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    expect(listWorkflowRunEdgeEvaluations(result.run.id)).toMatchObject([{
      edge_id: 'review-recover', source_node_id: 'review', target_node_id: 'recover',
      route: 'failure', status: 'taken', sequence: 0,
    }])
  })
  it('reruns a bounded feedback region with fresh sessions and stops when the condition is false', async () => {
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: true, output: 'draft 1' })
      .mockResolvedValueOnce({ ok: true, output: '{"retry":true}' })
      .mockResolvedValueOnce({ ok: true, output: 'draft 2' })
      .mockResolvedValueOnce({ ok: true, output: '{"retry":false}' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Bounded review retry', profile: 'default',
      nodes: [
        { id: 'draft', type: 'agent', data: { title: 'Draft', agent: 'hermes', input: 'draft' } },
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
      ],
      edges: [
        { id: 'draft-review', source: 'draft', target: 'review' },
        { id: 'review-retry', source: 'review', target: 'draft', data: { orchestration: {
          route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 2 },
        } } },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect({ status: result.run.status, error: result.run.error, calls: chatRunMock.runAndWait.mock.calls.length }).toEqual({ status: 'completed', error: null, calls: 4 })
    const sessionIds = chatRunMock.runAndWait.mock.calls.map(call => call[0].session_id)
    expect(new Set(sessionIds).size).toBe(4)
    const secondDraftInput = String(chatRunMock.runAndWait.mock.calls[2][0].input)
    expect(secondDraftInput).toContain('[Upstream: Review]')
    expect(secondDraftInput).toContain('{\"retry\":true}')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    expect(listWorkflowRunEdgeEvaluations(result.run.id).map(evidence => ({
      edge: evidence.edge_id, iteration: evidence.iteration_path,
    }))).toEqual([
      { edge: 'draft-review', iteration: [1] },
      { edge: 'review-retry', iteration: [1] },
      { edge: 'draft-review', iteration: [2] },
      { edge: 'review-retry', iteration: [2] },
    ])
  })

  it('resets child loop iterations when an outer feedback region retries', async () => {
    for (const output of [
      'outer 1', 'inner 1', '{"retryInner":true}', 'inner 2', '{"retryInner":false}',
      '{"retryOuter":true}', 'outer 2', 'inner 3', '{"retryInner":false}', '{"retryOuter":false}',
    ]) chatRunMock.runAndWait.mockResolvedValueOnce({ ok: true, output })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Nested retries', profile: 'default',
      nodes: [
        { id: 'outer', type: 'agent', data: { title: 'Outer', agent: 'hermes', input: 'outer' } },
        { id: 'inner', type: 'agent', data: { title: 'Inner', agent: 'hermes', input: 'inner' } },
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
        { id: 'finish', type: 'agent', data: { title: 'Finish', agent: 'hermes', input: 'finish' } },
      ],
      edges: [
        { id: 'outer-inner', source: 'outer', target: 'inner' },
        { id: 'inner-review', source: 'inner', target: 'review' },
        { id: 'review-finish', source: 'review', target: 'finish' },
        { id: 'review-inner', source: 'review', target: 'inner', data: { orchestration: {
          route: 'success', condition: { path: 'json.retryInner', operator: 'truthy' }, loop: { maxIterations: 2 },
        } } },
        { id: 'finish-outer', source: 'finish', target: 'outer', data: { orchestration: {
          route: 'success', condition: { path: 'json.retryOuter', operator: 'truthy' }, loop: { maxIterations: 2 },
        } } },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run.status).toBe('completed')
    const { listWorkflowRunNodeSessions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    expect(listWorkflowRunNodeSessions(result.run.id)
      .filter(session => session.node_id === 'inner')
      .map(session => session.iteration_path)).toEqual([[1, 1], [1, 2], [2, 1]])
  })

  it('fails before dispatching an iteration beyond the feedback limit', async () => {
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: true, output: 'draft 1' })
      .mockResolvedValueOnce({ ok: true, output: '{"retry":true}' })
      .mockResolvedValueOnce({ ok: true, output: 'draft 2' })
      .mockResolvedValueOnce({ ok: true, output: '{"retry":true}' })
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: 'Feedback limit', profile: 'default',
      nodes: [
        { id: 'draft', type: 'agent', data: { title: 'Draft', agent: 'hermes', input: 'draft' } },
        { id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review' } },
      ],
      edges: [
        { id: 'draft-review', source: 'draft', target: 'review' },
        { id: 'review-retry', source: 'review', target: 'draft', data: { orchestration: {
          route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 2 },
        } } },
      ],
    })
    const result = await manager.runNow(workflow.id)
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringContaining('loop_limit_exceeded') })
    expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
  })

})
