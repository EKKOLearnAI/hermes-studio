import { describe, expect, it } from 'vitest'
import {
  createWorkflowAuthoringEdge,
  normalizeWorkflowHandleId,
  validateWorkflowAuthoringLoops,
  workflowConnectionIsValid,
  workflowEdgeClosesCycle,
  workflowEdgeVisualType,
  workflowLoopBodyNodeIds,
  workflowSelfLoopPath,
} from '../../packages/client/src/utils/workflow-edge-authoring'

type TestEdge = {
  id: string
  source: string
  target: string
  data?: { orchestration?: { feedback?: { maxIterations: number } } }
}

const edge = (id: string, source: string, target: string, feedback = false): TestEdge => ({
  id,
  source,
  target,
  ...(feedback ? { data: { orchestration: { feedback: { maxIterations: 3 } } } } : {}),
})

describe('workflow edge authoring', () => {
  it('recognizes a backward connection as one loop and derives its node scope', () => {
    const edges = [
      edge('implement-review', 'implement', 'review'),
      edge('review-summary', 'review', 'summary'),
    ]

    expect(workflowEdgeClosesCycle('review', 'implement', edges)).toBe(true)
    expect(workflowLoopBodyNodeIds(
      ['implement', 'review', 'summary'],
      'review',
      'implement',
      edges,
    )).toEqual(['implement', 'review'])
  })

  it('treats a same-node connection as an intuitive self loop', () => {
    expect(workflowEdgeClosesCycle('review', 'review', [])).toBe(true)
    expect(workflowLoopBodyNodeIds(['review'], 'review', 'review', [])).toEqual(['review'])
    expect(workflowEdgeVisualType('review', 'review')).toBe('workflow-self-loop')
    expect(workflowEdgeVisualType('review', 'publish')).toBe('smoothstep')
  })

  it('accepts all four side handles while preserving legacy left and right handle ids', () => {
    expect(normalizeWorkflowHandleId('output', 'source')).toBe('output')
    expect(normalizeWorkflowHandleId('input', 'target')).toBe('input')
    expect(normalizeWorkflowHandleId('top', 'source')).toBe('top')
    expect(normalizeWorkflowHandleId('bottom', 'target')).toBe('bottom')
    expect(normalizeWorkflowHandleId('unknown', 'source')).toBe('output')
    expect(normalizeWorkflowHandleId('unknown', 'target')).toBe('input')

    expect(workflowConnectionIsValid({
      source: 'review', target: 'publish', sourceHandle: 'top', targetHandle: 'bottom',
    })).toBe(true)
    expect(workflowConnectionIsValid({
      source: 'review', target: 'review', sourceHandle: 'output', targetHandle: 'top',
    })).toBe(true)
    expect(workflowConnectionIsValid({
      source: 'review', target: 'review', sourceHandle: 'top', targetHandle: 'top',
    })).toBe(false)
  })

  it('creates a bounded feedback edge automatically when a connection closes a loop', () => {
    const forwardEdges = [edge('implement-review', 'implement', 'review')]
    expect(createWorkflowAuthoringEdge({
      source: 'review', target: 'implement', sourceHandle: 'bottom', targetHandle: 'top',
    }, forwardEdges)).toMatchObject({
      id: 'review-implement', source: 'review', target: 'implement',
      sourceHandle: 'bottom', targetHandle: 'top', type: 'smoothstep', animated: false,
      data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } },
    })
    expect(createWorkflowAuthoringEdge({
      source: 'review', target: 'review', sourceHandle: 'output', targetHandle: 'top',
    }, forwardEdges)).toMatchObject({
      id: 'review-review', type: 'workflow-self-loop',
      data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } },
    })
    expect(createWorkflowAuthoringEdge({
      source: 'review', target: 'summary', sourceHandle: 'output', targetHandle: 'input',
    }, forwardEdges)).toMatchObject({
      id: 'review-summary', type: 'smoothstep', animated: false,
      data: { orchestration: { route: 'success' } },
    })
  })

  it('draws a dedicated self-loop path outside the node for adjacent side handles', () => {
    const path = workflowSelfLoopPath({
      sourceX: 300, sourceY: 200, sourcePosition: 'right',
      targetX: 150, targetY: 0, targetPosition: 'top',
      nodeBounds: { left: 0, top: 0, right: 300, bottom: 200 },
    })
    expect(path).toMatch(/^M 300 200 /)
    expect(path).toContain('L 380 200')
    expect(path).toContain('L 380 -80')
    expect(path).toContain('L 150 -80')
    expect(path).toMatch(/150 0$/)
    expect(path).not.toContain('NaN')
  })

  it('routes opposite-side self loops around the card instead of through it', () => {
    const horizontal = workflowSelfLoopPath({
      sourceX: 0, sourceY: 100, sourcePosition: 'left',
      targetX: 300, targetY: 100, targetPosition: 'right',
      nodeBounds: { left: 0, top: 0, right: 300, bottom: 200 },
    })
    const vertical = workflowSelfLoopPath({
      sourceX: 150, sourceY: 0, sourcePosition: 'top',
      targetX: 150, targetY: 400, targetPosition: 'bottom',
      nodeBounds: { left: 0, top: 0, right: 300, bottom: 400 },
    })
    expect(horizontal).toBe('M 0 100 L -80 100 L -80 -80 L 380 -80 L 380 100 L 300 100')
    expect(vertical).toBe('M 150 0 L 150 -80 L 380 -80 L 380 480 L 150 480 L 150 400')
  })

  it('keeps all 12 directed handle combinations outside the real node bounds', () => {
    const bounds = { left: 0, top: 0, right: 300, bottom: 200 }
    const handles = {
      left: { x: bounds.left, y: 100 },
      top: { x: 150, y: bounds.top },
      right: { x: bounds.right, y: 100 },
      bottom: { x: 150, y: bounds.bottom },
    } as const
    const positions = Object.keys(handles) as Array<keyof typeof handles>

    for (const sourcePosition of positions) {
      for (const targetPosition of positions) {
        if (sourcePosition === targetPosition) continue
        const source = handles[sourcePosition]
        const target = handles[targetPosition]
        const path = workflowSelfLoopPath({
          sourceX: source.x,
          sourceY: source.y,
          sourcePosition,
          targetX: target.x,
          targetY: target.y,
          targetPosition,
          nodeBounds: bounds,
        })
        const points = [...path.matchAll(/[ML] (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
          .map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
        expect(points.length, `${sourcePosition} → ${targetPosition}: ${path}`).toBeGreaterThanOrEqual(5)

        for (let index = 1; index < points.length; index += 1) {
          const start = points[index - 1]
          const end = points[index]
          for (let step = 1; step < 20; step += 1) {
            const ratio = step / 20
            const x = start.x + (end.x - start.x) * ratio
            const y = start.y + (end.y - start.y) * ratio
            const inside = x > bounds.left && x < bounds.right && y > bounds.top && y < bounds.bottom
            expect(inside, `${sourcePosition} → ${targetPosition}: ${path} enters at ${x},${y}`).toBe(false)
          }
        }
      }
    }
  })

  it('accepts disjoint and nested loops but rejects ambiguous loop scopes', () => {
    const disjoint = [
      edge('a-b', 'a', 'b'), edge('b-a', 'b', 'a', true),
      edge('c-d', 'c', 'd'), edge('d-c', 'd', 'c', true),
    ]
    expect(validateWorkflowAuthoringLoops(['a', 'b', 'c', 'd'], disjoint)).toBeNull()

    const nested = [
      edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('c-d', 'c', 'd'),
      edge('d-a', 'd', 'a', true), edge('c-b', 'c', 'b', true),
    ]
    expect(validateWorkflowAuthoringLoops(['a', 'b', 'c', 'd'], nested)).toBeNull()

    const identical = [
      edge('a-b', 'a', 'b'), edge('b-a-one', 'b', 'a', true), edge('b-a-two', 'b', 'a', true),
    ]
    expect(validateWorkflowAuthoringLoops(['a', 'b'], identical)).toEqual({
      type: 'identical_loop_bodies', edgeIds: ['b-a-one', 'b-a-two'],
    })

    const partial = [
      edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('c-d', 'c', 'd'),
      edge('c-a', 'c', 'a', true), edge('d-b', 'd', 'b', true),
    ]
    expect(validateWorkflowAuthoringLoops(['a', 'b', 'c', 'd'], partial)).toEqual({
      type: 'partially_overlapping_loop_bodies', edgeIds: ['c-a', 'd-b'],
    })
  })

  it('rejects feedback without a forward path and duplicate custom history labels', () => {
    expect(validateWorkflowAuthoringLoops(['a', 'b'], [edge('b-a', 'b', 'a', true)])).toEqual({
      type: 'feedback_without_forward_path', edgeIds: ['b-a'],
    })
    const duplicateLabels = [
      { ...edge('b-a', 'b', 'a', true), data: { orchestration: { feedback: { maxIterations: 3, loopId: 'retry' } } } },
      edge('a-b', 'a', 'b'), edge('c-d', 'c', 'd'),
      { ...edge('d-c', 'd', 'c', true), data: { orchestration: { feedback: { maxIterations: 3, loopId: 'retry' } } } },
    ]
    expect(validateWorkflowAuthoringLoops(['a', 'b', 'c', 'd'], duplicateLabels)).toEqual({
      type: 'duplicate_loop_id', edgeIds: ['b-a', 'd-c'],
    })
  })

  it('rejects a feedback scope whose header does not dominate the latch', () => {
    const edges = [
      edge('entry-header', 'entry', 'header'),
      edge('header-body', 'header', 'body'),
      edge('body-latch', 'body', 'latch'),
      edge('entry-body', 'entry', 'body'),
      edge('retry', 'latch', 'header', true),
    ]
    expect(validateWorkflowAuthoringLoops(['entry', 'header', 'body', 'latch'], edges)).toEqual({
      type: 'feedback_not_natural_loop', edgeIds: ['retry'],
    })
  })

  it('ignores existing feedback connections when deriving a new loop scope', () => {
    const edges = [
      edge('a-b', 'a', 'b'),
      edge('b-a', 'b', 'a', true),
      edge('b-c', 'b', 'c'),
    ]

    expect(workflowLoopBodyNodeIds(['a', 'b', 'c'], 'b', 'a', edges, 'b-a')).toEqual(['a', 'b'])
    expect(workflowEdgeClosesCycle('a', 'c', edges)).toBe(false)
  })
})
