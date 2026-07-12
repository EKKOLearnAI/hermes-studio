import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null, appHome: '' }))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(), jsonGet: vi.fn(), jsonGetAll: vi.fn(() => ({})), jsonSet: vi.fn(),
}))
vi.mock('../../packages/server/src/config', () => ({ config: { appHome: state.appHome } }))

describe('workflow edge evaluation store', () => {
  let root: string

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-workflow-edge-evaluation-'))
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

  it('appends edge evaluations in deterministic sequence order', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      createWorkflowRun,
      createWorkflowRunEdgeEvaluation,
      listWorkflowRunEdgeEvaluations,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'Evidence', profile: 'default' })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running' })

    const second = createWorkflowRunEdgeEvaluation({
      run_id: run.id, workflow_id: workflow.id, edge_id: 'review-publish',
      source_node_id: 'review', target_node_id: 'publish', route: 'success',
      status: 'not_taken', reason: 'condition did not match', sequence: 2, evaluated_at: 200,
    })
    const first = createWorkflowRunEdgeEvaluation({
      run_id: run.id, workflow_id: workflow.id, edge_id: 'review-recover',
      source_node_id: 'review', target_node_id: 'recover', route: 'failure',
      status: 'taken', reason: 'failure route matched', sequence: 1, evaluated_at: 100,
    })

    expect(first.id).not.toBe(second.id)
    expect(listWorkflowRunEdgeEvaluations(run.id)).toMatchObject([
      { id: first.id, edge_id: 'review-recover', status: 'taken', sequence: 1, evaluated_at: 100 },
      { id: second.id, edge_id: 'review-publish', status: 'not_taken', sequence: 2, evaluated_at: 200 },
    ])
  })

  it('fails closed when persisted evidence violates the database schema', async () => {
    state.db!.exec(`
      CREATE UNIQUE INDEX uniq_workflow_edge_sequence
      ON workflow_run_edge_evaluations(run_id, sequence)
    `)
    const { createWorkflowRunEdgeEvaluation } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const input = {
      run_id: 'run-1', workflow_id: 'workflow-1', edge_id: 'edge-1',
      source_node_id: 'source', target_node_id: 'target', route: 'success' as const,
      status: 'taken' as const, reason: 'route matched', sequence: 0,
    }
    createWorkflowRunEdgeEvaluation(input)
    expect(() => createWorkflowRunEdgeEvaluation({ ...input, edge_id: 'edge-2' })).toThrow()
  })

  it('returns no evidence for legacy databases before the evidence table exists', async () => {
    state.db!.exec('DROP TABLE workflow_run_edge_evaluations')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    expect(listWorkflowRunEdgeEvaluations('legacy-run')).toEqual([])
  })

  it('deletes edge evaluations with their workflow run', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      createWorkflowRun,
      createWorkflowRunEdgeEvaluation,
      deleteWorkflowRun,
      listWorkflowRunEdgeEvaluations,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'Evidence cleanup', profile: 'default' })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed' })
    createWorkflowRunEdgeEvaluation({
      run_id: run.id, workflow_id: workflow.id, edge_id: 'edge-1',
      source_node_id: 'source', target_node_id: 'target', route: 'success',
      status: 'taken', reason: 'success route matched', sequence: 0,
    })

    expect(listWorkflowRunEdgeEvaluations(run.id)).toHaveLength(1)
    expect(deleteWorkflowRun(run.id)).toBe(true)
    expect(listWorkflowRunEdgeEvaluations(run.id)).toEqual([])
  })
})
