import { describe, expect, it } from 'vitest'
import { normalizeWorkflowRunEdge } from '../../packages/client/src/utils/workflow-run-snapshot'

describe('Workflow run snapshot playback', () => {
  it('preserves authored handles, labels, animation, and orchestration data', () => {
    expect(normalizeWorkflowRunEdge({
      id: 'review-retry',
      source: 'review',
      target: 'code',
      sourceHandle: 'bottom',
      targetHandle: 'bottom',
      label: 'RETRY',
      animated: true,
      data: {
        orchestration: {
          route: 'success',
          condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' },
          feedback: { maxIterations: 3, loopId: 'code-review' },
        },
      },
    })).toMatchObject({
      id: 'review-retry',
      sourceHandle: 'bottom',
      targetHandle: 'bottom',
      label: 'RETRY',
      animated: true,
      data: {
        orchestration: {
          condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' },
          feedback: { maxIterations: 3, loopId: 'code-review' },
        },
      },
    })
  })

  it('adapts legacy compiled-only orchestration without inventing missing handles', () => {
    expect(normalizeWorkflowRunEdge({
      id: 'legacy-review-retry',
      source: 'review',
      target: 'code',
      orchestration: {
        route: 'success',
        condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' },
        feedback: { maxIterations: 3, loopId: 'code-review' },
      },
    })).toMatchObject({
      id: 'legacy-review-retry',
      sourceHandle: 'output',
      targetHandle: 'input',
      data: {
        orchestration: {
          condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' },
          feedback: { maxIterations: 3, loopId: 'code-review' },
        },
      },
    })
  })
})
