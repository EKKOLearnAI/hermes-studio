import { describe, expect, it } from 'vitest'
import { workflowNodeSessionByExecution } from '@/utils/workflow-history'
import type { WorkflowRunNodeSessionRecord } from '@/api/studio/workflows'

function record(executionId: string, sequence: number): WorkflowRunNodeSessionRecord {
  return {
    id: executionId,
    run_id: 'run-1',
    workflow_id: 'workflow-1',
    node_id: 'node-1',
    execution_id: executionId,
    iteration_path: [],
    consumed_edge_evaluation_ids: [],
    session_id: `session-${executionId}`,
    profile: 'research',
    agent: 'agent',
    agent_mode: 'default',
    status: 'pending_approval',
    sequence,
    started_at: null,
    finished_at: null,
    created_at: sequence,
    updated_at: sequence,
    error: null,
  }
}

describe('Workflow notification execution target', () => {
  it('selects the requested non-latest execution instead of the latest node execution', () => {
    const older = record('execution-1', 1)
    const latest = record('execution-2', 2)
    expect(workflowNodeSessionByExecution([older, latest], 'node-1', 'execution-1')).toBe(older)
  })
})