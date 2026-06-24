import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  get: vi.fn(),
  deleteRun: vi.fn(),
  runNow: vi.fn(),
  stopRun: vi.fn(),
}))
const listWorkflowRunsMock = vi.hoisted(() => vi.fn())
const listWorkflowRunNodeSessionsMock = vi.hoisted(() => vi.fn())
const listUserProfilesMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/workflow-manager', () => ({
  getWorkflowManager: () => managerMock,
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles: listUserProfilesMock,
}))

vi.mock('../../packages/server/src/db/hermes/workflow-run-store', () => ({
  listWorkflowRunNodeSessions: listWorkflowRunNodeSessionsMock,
  listWorkflowRuns: listWorkflowRunsMock,
}))

function ctx(overrides: Record<string, any> = {}) {
  return {
    params: {},
    query: {},
    request: { body: {} },
    state: {},
    status: 200,
    body: undefined,
    ...overrides,
  } as any
}

describe('workflow controller', () => {
  beforeEach(() => {
    managerMock.get.mockReset()
    managerMock.deleteRun.mockReset()
    managerMock.runNow.mockReset()
    managerMock.stopRun.mockReset()
    listWorkflowRunNodeSessionsMock.mockReset()
    listWorkflowRunsMock.mockReset()
    listUserProfilesMock.mockReset()
    listUserProfilesMock.mockReturnValue([])
  })

  it('lists run records for a workflow', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    listWorkflowRunsMock.mockReturnValue([{ id: 'run-1', workflow_id: 'workflow-1', status: 'completed' }])
    listWorkflowRunNodeSessionsMock.mockReturnValue([{ id: 'node-session-1', node_id: 'node-1', status: 'completed' }])

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1' }, query: { limit: '25' } })

    await mod.listRuns(c)

    expect(listWorkflowRunsMock).toHaveBeenCalledWith('workflow-1', 25)
    expect(listWorkflowRunNodeSessionsMock).toHaveBeenCalledWith('run-1')
    expect(c.body).toEqual({
      runs: [{
        id: 'run-1',
        workflow_id: 'workflow-1',
        status: 'completed',
        node_sessions: [{ id: 'node-session-1', node_id: 'node-1', status: 'completed' }],
      }],
    })
  })

  it('runs a workflow through the workflow manager', async () => {
    const user = { id: 'user-1', role: 'super_admin' }
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.runNow.mockResolvedValue({ run: { id: 'run-1', status: 'completed' }, nodeSessions: [] })

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({
      params: { id: 'workflow-1' },
      request: { body: { start_node_ids: ['node-1', 12, 'node-2'], input: 'go', timeout_ms: '1000' } },
      state: { user },
    })

    await mod.runNow(c)

    expect(managerMock.runNow).toHaveBeenCalledWith('workflow-1', {
      profile: 'default',
      user,
      startNodeIds: ['node-1', 'node-2'],
      input: 'go',
      timeoutMs: 1000,
    })
    expect(c.status).toBe(202)
    expect(c.body).toEqual({ ok: true, status: 'accepted' })
  })

  it('stops a workflow run through the workflow manager', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.stopRun.mockResolvedValue({ id: 'run-1', workflow_id: 'workflow-1', status: 'canceled' })

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' } })

    await mod.stopRun(c)

    expect(managerMock.stopRun).toHaveBeenCalledWith('workflow-1', 'run-1', 'Workflow run canceled by user')
    expect(c.body).toEqual({
      ok: true,
      run: { id: 'run-1', workflow_id: 'workflow-1', status: 'canceled' },
    })
  })

  it('deletes a workflow run through the workflow manager', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.deleteRun.mockResolvedValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' } })

    await mod.deleteRun(c)

    expect(managerMock.deleteRun).toHaveBeenCalledWith('workflow-1', 'run-1')
    expect(c.body).toEqual({ ok: true })
  })

  it('rejects workflow runs for unavailable profiles', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'secret' })
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }])

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({
      params: { id: 'workflow-1' },
      state: { user: { id: 'user-1', role: 'user' } },
    })

    await mod.runNow(c)

    expect(c.status).toBe(403)
    expect(managerMock.runNow).not.toHaveBeenCalled()
  })
})
