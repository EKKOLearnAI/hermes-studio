import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    appHome: state.appHome,
  },
}))

describe('workflow store', () => {
  let root: string

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-workflow-store-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('creates workflows with a profile-scoped default workspace', async () => {
    const { createWorkflow, getWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')

    const workflow = createWorkflow({
      name: 'Research flow',
      profile: 'research',
      nodes: [{ id: 'agent-1' }],
      edges: [],
      viewport: { x: 12, y: 24, zoom: 0.8 },
    })

    expect(workflow.profile).toBe('research')
    expect(workflow.workspace).toBe(join(state.appHome, 'workflow', 'research', workflow.id))
    expect(existsSync(workflow.workspace!)).toBe(true)
    expect(getWorkflow(workflow.id)).toMatchObject({
      id: workflow.id,
      name: 'Research flow',
      profile: 'research',
      nodes: [{ id: 'agent-1' }],
      viewport: { x: 12, y: 24, zoom: 0.8 },
    })
  })

  it('updates and deletes workflows', async () => {
    const { createWorkflow, deleteWorkflow, getWorkflow, listWorkflows, updateWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const workflow = createWorkflow({ name: 'Draft', profile: 'default' })

    const updated = updateWorkflow(workflow.id, {
      name: 'Updated',
      workspace: null,
      nodes: [{ id: 'agent-2' }],
      edges: [{ source: 'agent-1', target: 'agent-2' }],
      viewport: { x: -120, y: 88, zoom: 1.1 },
    })

    expect(updated).toMatchObject({
      id: workflow.id,
      name: 'Updated',
      nodes: [{ id: 'agent-2' }],
      edges: [{ source: 'agent-1', target: 'agent-2' }],
      viewport: { x: -120, y: 88, zoom: 1.1 },
    })
    expect(updated?.workspace).toBe(workflow.workspace)
    expect(listWorkflows('default').map(item => item.id)).toContain(workflow.id)
    expect(deleteWorkflow(workflow.id)).toBe(true)
    expect(getWorkflow(workflow.id)).toBeNull()
  })

  it('lists workflow runs by workflow ordered newest first', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun, listWorkflowRuns, updateWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'Runs', profile: 'default' })
    const other = createWorkflow({ name: 'Other', profile: 'default' })

    const first = createWorkflowRun({ workflow_id: workflow.id, status: 'running', started_at: 100 })
    await new Promise(resolve => setTimeout(resolve, 2))
    const second = createWorkflowRun({ workflow_id: workflow.id, status: 'queued', started_at: 200 })
    createWorkflowRun({ workflow_id: other.id, status: 'running' })
    updateWorkflowRun(first.id, { status: 'completed', finished_at: 300 })

    expect(listWorkflowRuns(workflow.id).map(run => run.id)).toEqual([second.id, first.id])
    expect(listWorkflowRuns(workflow.id, 1)).toHaveLength(1)
    expect(listWorkflowRuns(workflow.id)[1]).toMatchObject({
      id: first.id,
      status: 'completed',
      finished_at: 300,
    })
  })

  it('deletes workflow runs and their node session records', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      createWorkflowRun,
      createWorkflowRunNodeSession,
      deleteWorkflowRun,
      getWorkflowRun,
      listWorkflowRunNodeSessions,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'Runs', profile: 'default' })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed' })
    createWorkflowRunNodeSession({
      run_id: run.id,
      workflow_id: workflow.id,
      node_id: 'node-1',
      session_id: 'session-1',
      status: 'completed',
    })

    expect(listWorkflowRunNodeSessions(run.id)).toHaveLength(1)
    expect(deleteWorkflowRun(run.id)).toBe(true)

    expect(getWorkflowRun(run.id)).toBeNull()
    expect(listWorkflowRunNodeSessions(run.id)).toEqual([])
  })
})
