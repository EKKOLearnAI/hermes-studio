import { describe, expect, it } from 'vitest'
import { buildWorkflowEvidenceRows, formatIterationPath, latestWorkflowNodeSession } from '../../packages/client/src/utils/workflow-history'

const path = [{ loopId: 'outer', iteration: 1 }, { loopId: 'inner', iteration: 2 }]

describe('workflow history evidence', () => {
  it('formats canonical nested iteration paths without losing hierarchy', () => {
    expect(formatIterationPath(path)).toBe('outer#2 / inner#3')
    expect(formatIterationPath([])).toBe('—')
  })


  it('keeps rerun execution scope visible in canonical history paths', () => {
    const scoped = [{ executionScope: 'rerun:1783910000000', loopId: 'outer', iteration: 1 }, { executionScope: 'rerun:1783910000000', loopId: 'inner', iteration: 2 }]
    expect(formatIterationPath(scoped)).toBe('rerun:1783910000000 · outer#2 / inner#3')
  })

  it('selects the latest node execution by sequence for canvas status, errors, and session opening', () => {
    const sessions = [
      { node_id: 'agent', execution_id: 'agent', sequence: 1, status: 'failed', error: 'old failure' },
      { node_id: 'other', execution_id: 'other', sequence: 3, status: 'completed', error: null },
      { node_id: 'agent', execution_id: 'rerun:2:agent', sequence: 5, status: 'completed', error: null },
    ] as any
    expect(latestWorkflowNodeSession(sessions, 'agent')?.execution_id).toBe('rerun:2:agent')
    expect(latestWorkflowNodeSession(sessions, 'missing')).toBeUndefined()
  })

  it('keeps route, loop, and exceptional node evidence while omitting node states already replayed on the canvas', () => {
    const rows = buildWorkflowEvidenceRows({
      snapshot_nodes: [
        { id: 'agent', data: { title: 'Writer' } },
        { id: 'review', data: { title: 'Reviewer' } },
      ],
      node_sessions: [
        { execution_id: 'agent@2', node_id: 'agent', status: 'completed', sequence: 3, iteration_path: path },
        { execution_id: 'review@2', node_id: 'review', status: 'failed', error: 'review failed', sequence: 4, iteration_path: path },
      ],
      edge_evaluations: [{ edge_id: 'retry', status: 'taken', reason: 'condition_matched', source_node_id: 'agent', target_node_id: 'review', source_execution_id: 'agent@2', route: 'success', source_outcome: 'success', sequence: 2, iteration_path: path }],
      loop_epochs: [{ loop_id: 'loop:retry', iteration: 1, status: 'completed', exit_reason: 'feedback_taken', sequence: 1, iteration_path: path }],
    } as any)
    expect(rows.map(row => `${row.kind}:${row.sequence}:${row.technicalId}`)).toEqual([
      'loop:1:loop:retry',
      'edge:2:retry',
      'node:4:review@2',
    ])
    expect(rows[0]).toMatchObject({ iteration: 1, exitReason: 'feedback_taken' })
    expect(rows[1]).toMatchObject({ sourceTitle: 'Writer', targetTitle: 'Reviewer', route: 'success', reason: 'condition_matched' })
    expect(rows[2]).toMatchObject({ nodeTitle: 'Reviewer', error: 'review failed' })
    expect(rows.every(row => row.iterationPath === 'outer#2 / inner#3')).toBe(true)
  })
})
