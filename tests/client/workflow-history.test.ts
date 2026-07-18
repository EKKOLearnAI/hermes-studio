import { describe, expect, it } from 'vitest'
import { buildWorkflowEvidenceRows, formatIterationPath, latestWorkflowNodeSession, summarizeWorkflowEvidenceRows, workflowEdgePlaybackState } from '../../packages/client/src/utils/workflow-history'

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

  it('uses the selected node name instead of a loop id in operator-facing history', () => {
    const rows = buildWorkflowEvidenceRows({
      snapshot_nodes: [
        { id: 'prepare', data: { title: 'Prepare release' } },
        { id: 'review', data: { title: 'Review release' } },
      ],
      compiled_loops: [{
        id: 'legacy-loop-id', feedbackEdgeId: 'review-prepare',
        headerNodeId: 'prepare', latchNodeId: 'review', bodyNodeIds: ['prepare', 'review'],
        maxIterations: 3, parentLoopId: null,
      }],
      node_sessions: [],
      edge_evaluations: [],
      loop_epochs: [{
        loop_id: 'legacy-loop-id', iteration: 1, status: 'completed', exit_reason: 'feedback_taken',
        sequence: 1, iteration_path: [{ loopId: 'legacy-loop-id', iteration: 1 }],
      }],
    } as any)

    expect(rows[0]).toMatchObject({ kind: 'loop', loopTitle: 'Prepare release' })
    expect(rows[0].iterationPath).toBe('Prepare release#2')
    expect(rows[0].iterationPath).not.toContain('legacy-loop-id')
  })

  it('keeps missing snapshot titles absent instead of promoting technical node ids to user-facing labels', () => {
    const sourceId = '11111111-1111-4111-8111-111111111111'
    const targetId = '22222222-2222-4222-8222-222222222222'
    const rows = buildWorkflowEvidenceRows({
      snapshot_nodes: [{ id: sourceId, data: {} }, { id: targetId, data: {} }],
      node_sessions: [{
        execution_id: `${sourceId}@1`, node_id: sourceId, status: 'failed', error: 'failed',
        sequence: 2, iteration_path: [],
      }],
      edge_evaluations: [{
        edge_id: 'edge-1', source_node_id: sourceId, target_node_id: targetId,
        source_execution_id: sourceId, source_outcome: 'success', status: 'taken', route: 'success',
        reason: null, sequence: 1, iteration_path: [],
      }],
      loop_epochs: [],
    } as any)

    expect(rows[0]).toMatchObject({ kind: 'edge', sourceTitle: undefined, targetTitle: undefined })
    expect(rows[1]).toMatchObject({ kind: 'node', nodeTitle: undefined })
    expect(rows[1].technicalId).toBe(`${sourceId}@1`)
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

  it('extracts the upstream business blocker when a success path condition is not matched', () => {
    const [row] = buildWorkflowEvidenceRows({
      snapshot_nodes: [
        { id: 'publish', data: { title: 'Publish release' } },
        { id: 'verify', data: { title: 'Verify release' } },
      ],
      node_sessions: [],
      edge_evaluations: [{
        edge_id: 'publish-to-verify', source_node_id: 'publish', target_node_id: 'verify',
        source_execution_id: 'publish', source_outcome: 'success', status: 'not_taken', route: 'success',
        reason: 'condition_not_matched', sequence: 9, iteration_path: [],
        orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'PUBLISHED' } },
        condition_evaluation: {
          status: 'not_matched', reason: 'not_equal',
          actual: '\n```json\n{"decision":"BLOCKED","route_marker":"BLOCKED","reason":"The release lock was missing before publication."}\n```',
        },
      }],
      loop_epochs: [],
    } as any)

    expect(row).toMatchObject({
      kind: 'edge', sourceTitle: 'Publish release', targetTitle: 'Verify release',
      sourceOutcome: 'success', conditionPath: 'output', conditionOperator: 'contains',
      expectedValue: 'PUBLISHED', businessDecision: 'BLOCKED',
      businessReason: 'The release lock was missing before publication.',
    })
    expect(row.conditionActualValue).toContain('"decision":"BLOCKED"')
    expect(row.conditionActualValue).toContain('"route_marker":"BLOCKED"')
  })

  it('sanitizes and bounds business explanations instead of exposing the full node output', () => {
    const reason = `lock missing\0${'x'.repeat(800)}`
    const decision = `BLOCKED\0${'y'.repeat(120)}`
    const [row] = buildWorkflowEvidenceRows({
      snapshot_nodes: [{ id: 'publish' }, { id: 'verify' }],
      node_sessions: [],
      edge_evaluations: [{
        edge_id: 'publish-to-verify', source_node_id: 'publish', target_node_id: 'verify',
        source_execution_id: 'publish', source_outcome: 'success', status: 'not_taken', route: 'success',
        reason: 'condition_not_matched', sequence: 1, iteration_path: [],
        orchestration: { condition: { path: 'output', operator: 'contains', value: 'PUBLISHED' } },
        condition_evaluation: { actual: JSON.stringify({ decision, route_marker: decision, reason }) },
      }],
      loop_epochs: [],
    } as any)

    expect(row.businessReason).not.toContain('\0')
    expect(row.businessReason?.length).toBeLessThanOrEqual(600)
    expect(row.businessReason).toMatch(/\.\.\.$/)
    expect(row.businessDecision).not.toContain('\0')
    expect(row.businessDecision?.length).toBeLessThanOrEqual(80)
    expect(row.conditionActualValue).toContain('"decision"')
    expect(row.conditionActualValue).not.toContain('\0')
    expect(row.conditionActualValue?.length).toBeLessThanOrEqual(240)
  })

  it('projects structured decision fields without treating ordinary JSON fields as business codes', () => {
    const rowFor = (path: string, actual: unknown) => buildWorkflowEvidenceRows({
      snapshot_nodes: [{ id: 'source' }, { id: 'target' }],
      node_sessions: [],
      edge_evaluations: [{
        edge_id: 'source-target', source_node_id: 'source', target_node_id: 'target',
        source_execution_id: 'source', source_outcome: 'success', status: 'not_taken', route: 'success',
        reason: 'condition_not_matched', sequence: 1, iteration_path: [],
        orchestration: { condition: { path, operator: 'equals', value: 'PUBLISHED' } },
        condition_evaluation: { status: 'not_matched', actual },
      }],
      loop_epochs: [],
    } as any)[0]

    expect(rowFor('outputJson.decision', 'BLOCKED')).toMatchObject({
      conditionActualValue: 'BLOCKED', businessDecision: 'BLOCKED',
    })
    expect(rowFor('outputJson.route_marker', 'RELEASE_BLOCKED')).toMatchObject({
      conditionActualValue: 'RELEASE_BLOCKED', businessDecision: 'RELEASE_BLOCKED',
    })
    expect(rowFor('outputJson.failed_gate', 'image-build')).toMatchObject({
      conditionActualValue: 'image-build', businessDecision: undefined,
    })
  })

  it('preserves falsy condition operands separately from parsed business projections', () => {
    const rowFor = (actual: unknown) => buildWorkflowEvidenceRows({
      snapshot_nodes: [{ id: 'source' }, { id: 'target' }],
      node_sessions: [],
      edge_evaluations: [{
        edge_id: 'source-target', source_node_id: 'source', target_node_id: 'target',
        source_execution_id: 'source', source_outcome: 'success', status: 'not_taken', route: 'success',
        reason: 'condition_not_matched', sequence: 1, iteration_path: [],
        orchestration: { condition: { path: 'outputJson.flag', operator: 'equals', value: true } },
        condition_evaluation: { status: 'not_matched', actual },
      }],
      loop_epochs: [],
    } as any)[0]

    expect(rowFor(false)).toMatchObject({ conditionActualValue: 'false', businessDecision: undefined })
    expect(rowFor(0)).toMatchObject({ conditionActualValue: '0', businessDecision: undefined })
    expect(rowFor('')).toMatchObject({ conditionActualValue: '', businessDecision: undefined })
    expect(rowFor(null)).toMatchObject({ conditionActualValue: 'null', businessDecision: undefined })
  })

  it('fails business summaries closed for malformed or ambiguous structured output', () => {
    const rowFor = (actual: string) => buildWorkflowEvidenceRows({
      snapshot_nodes: [{ id: 'publish' }, { id: 'verify' }],
      node_sessions: [],
      edge_evaluations: [{
        edge_id: 'publish-to-verify', source_node_id: 'publish', target_node_id: 'verify',
        source_execution_id: 'publish', source_outcome: 'success', status: 'not_taken', route: 'success',
        reason: 'condition_not_matched', sequence: 1, iteration_path: [],
        orchestration: { condition: { path: 'output', operator: 'contains', value: 'RELEASED' } },
        condition_evaluation: { status: 'not_matched', actual },
      }],
      loop_epochs: [],
    } as any)[0]
    const result = { decision: 'BLOCKED', failed_gate: 'quality', reason: 'Tests failed.' }

    expect(rowFor(JSON.stringify(result))).toMatchObject({ businessDecision: 'BLOCKED', businessGate: 'quality' })
    expect(rowFor(`Result:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``)).toMatchObject({ businessDecision: 'BLOCKED', businessGate: 'quality' })
    for (const output of [
      `prefix ${JSON.stringify(result)} suffix`,
      `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n\`\`\`json\n{"decision":"RELEASED"}\n\`\`\``,
      `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n\`\`\`json\n{"decision":"RELEASED"`,
      '```json\n{"decision":\n```',
    ]) {
      expect(rowFor(output)).toMatchObject({
        businessDecision: undefined,
        businessGate: undefined,
        businessReason: undefined,
      })
    }
  })

  it('summarizes the chosen path and blocker separately from unused alternatives', () => {
    const blockedOutput = JSON.stringify({
      decision: 'BLOCKED',
      failed_gate: 'quality-container-setup',
      reason: 'The container workdir did not exist.',
      side_effects_completed: [],
    })
    const rows = buildWorkflowEvidenceRows({
      snapshot_nodes: [
        { id: 'publish', data: { title: 'Build and publish' } },
        { id: 'verify', data: { title: 'Verify release' } },
        { id: 'blocked', data: { title: 'Blocked outcome' } },
        { id: 'summary', data: { title: 'Plain-language summary' } },
      ],
      node_sessions: [],
      edge_evaluations: [{
        edge_id: 'publish-verify', source_node_id: 'publish', target_node_id: 'verify',
        source_execution_id: 'publish', source_outcome: 'success', status: 'not_taken', route: 'success',
        reason: 'condition_not_matched', sequence: 1, iteration_path: [],
        orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'HSR_RELEASED_OK' } },
        condition_evaluation: { status: 'not_matched', reason: 'not_equal', actual: blockedOutput },
      }, {
        edge_id: 'publish-blocked', source_node_id: 'publish', target_node_id: 'blocked',
        source_execution_id: 'publish', source_outcome: 'success', status: 'taken', route: 'success',
        reason: null, sequence: 2, iteration_path: [],
        orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'failed_gate' } },
        condition_evaluation: { status: 'matched', actual: blockedOutput },
      }, {
        edge_id: 'blocked-summary', source_node_id: 'blocked', target_node_id: 'summary',
        source_execution_id: 'blocked', source_outcome: 'success', status: 'taken', route: 'always',
        reason: null, sequence: 3, iteration_path: [], orchestration: { route: 'always' }, condition_evaluation: null,
      }],
      loop_epochs: [],
    } as any)

    const overview = summarizeWorkflowEvidenceRows(rows)
    expect(overview).toMatchObject({
      businessDecision: 'BLOCKED',
      businessGate: 'quality-container-setup',
      businessReason: 'The container workdir did not exist.',
    })
    expect(overview.takenEdges.map(row => `${row.sourceTitle} → ${row.targetTitle}`)).toEqual([
      'Build and publish → Blocked outcome',
      'Blocked outcome → Plain-language summary',
    ])
    expect(overview.otherRows.map(row => row.technicalId)).toEqual(['publish-verify'])
    expect(overview.takenEdges[0]).toMatchObject({
      conditionMatched: true,
      conditionPath: 'output',
      conditionOperator: 'contains',
      expectedValue: 'failed_gate',
      businessGate: 'quality-container-setup',
    })
    expect(overview.otherRows[0]).toMatchObject({ conditionMatched: false })
  })

  it('maps persisted edge decisions and the target node state to canvas playback states', () => {
    const edgeRow = (status: string) => ({ kind: 'edge', technicalId: 'publish-summary', status }) as any

    expect(workflowEdgePlaybackState('publish-summary', 'idle', 'running', [])).toBe('idle')
    expect(workflowEdgePlaybackState('publish-summary', 'idle', 'running', [edgeRow('not_taken')])).toBe('inactive')
    expect(workflowEdgePlaybackState('publish-summary', 'running', 'running', [edgeRow('taken')])).toBe('flowing')
    expect(workflowEdgePlaybackState('publish-summary', 'completed', 'running', [edgeRow('taken')])).toBe('completed')
    expect(workflowEdgePlaybackState('publish-summary', 'failed', 'failed', [edgeRow('taken')])).toBe('failed')
    expect(workflowEdgePlaybackState('publish-summary', 'blocked', 'failed', [edgeRow('taken')])).toBe('failed')
    expect(workflowEdgePlaybackState('publish-summary', 'canceled', 'canceled', [edgeRow('taken')])).toBe('failed')
    expect(workflowEdgePlaybackState('publish-summary', 'idle', 'failed', [edgeRow('error')])).toBe('failed')
    expect(workflowEdgePlaybackState('publish-summary', 'completed', 'completed', [
      { ...edgeRow('taken'), businessDecision: 'BLOCKED', businessGate: 'quality' },
    ])).toBe('blocked')
    expect(workflowEdgePlaybackState('publish-summary', 'running', 'running', [
      { ...edgeRow('taken'), businessDecision: 'BLOCKED', businessGate: 'quality' },
    ])).toBe('blocked-flowing')
    expect(workflowEdgePlaybackState('publish-summary', 'running', 'running', [
      { ...edgeRow('taken'), sourceOutcome: 'failure' },
    ])).toBe('failed-flowing')
    expect(workflowEdgePlaybackState('publish-summary', 'completed', 'completed', [
      edgeRow('taken'), edgeRow('not_taken'),
    ])).toBe('completed')
  })

})
