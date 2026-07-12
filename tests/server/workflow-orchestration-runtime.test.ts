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
})
