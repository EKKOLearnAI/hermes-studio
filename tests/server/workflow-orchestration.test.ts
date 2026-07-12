import { describe, expect, it } from 'vitest'
import {
  compileWorkflowGraph,
  evaluateWorkflowEdge,
  normalizeWorkflowEdgePolicy,
  normalizeWorkflowJoinMode,
  parseWorkflowJsonOutput,
} from '../../packages/server/src/services/workflow-orchestration'

describe('workflow orchestration contract', () => {
  it('preserves existing workflows as unconditional success routes with all joins', () => {
    expect(normalizeWorkflowEdgePolicy(undefined)).toEqual({ route: 'success' })
    expect(normalizeWorkflowJoinMode(undefined)).toBe('all')
  })

  it('evaluates declarative routes and JSON conditions without executable expressions', () => {
    expect(parseWorkflowJsonOutput('```json\n{"release":{"ready":true}}\n```'))
      .toEqual({ release: { ready: true } })
    expect(evaluateWorkflowEdge({
      id: 'review-publish', source: 'review', target: 'publish',
      data: { orchestration: { route: 'success', condition: { path: 'json.release.ready', operator: 'equals', value: true } } },
    }, {
      nodeId: 'review', status: 'success', output: '{"release":{"ready":true}}',
    })).toMatchObject({ status: 'taken', reason: 'condition matched' })
  })

  it('distinguishes valid JSON null from an unparseable output', () => {
    const edge = {
      source: 'review', target: 'publish',
      data: { orchestration: { route: 'success', condition: { path: 'json', operator: 'equals', value: null } } },
    }
    expect(evaluateWorkflowEdge(edge, { nodeId: 'review', status: 'success', output: 'null' }).status).toBe('taken')
    expect(evaluateWorkflowEdge(edge, { nodeId: 'review', status: 'success', output: 'not-json' })).toMatchObject({
      status: 'error',
      reason: expect.stringMatching(/valid JSON/),
    })
  })

  it('fails closed for malformed policies and unsafe property paths', () => {
    expect(() => normalizeWorkflowEdgePolicy({ route: 'maybe' })).toThrow(/route/)
    expect(() => normalizeWorkflowEdgePolicy({ route: 'success', condition: { path: 'json.__proto__.ready', operator: 'truthy' } })).toThrow(/path/)
    expect(() => normalizeWorkflowJoinMode('sometimes')).toThrow(/joinMode/)
  })

  it('compiles a valid DAG and rejects duplicate identities, dangling edges, and cycles', () => {
    expect(compileWorkflowGraph(
      [{ id: 'draft' }, { id: 'review' }],
      [{ source: 'draft', target: 'review' }],
    )).toMatchObject({
      nodes: [{ id: 'draft' }, { id: 'review' }],
      edges: [{ id: 'draft->review#0', source: 'draft', target: 'review' }],
    })
    expect(() => compileWorkflowGraph([{ id: 'a' }, { id: 'a' }], [])).toThrow(/duplicate node id/)
    expect(() => compileWorkflowGraph([{ id: 'a' }], [{ source: 'a', target: 'missing' }])).toThrow(/missing target/)
    expect(() => compileWorkflowGraph(
      [{ id: 'a' }, { id: 'b' }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
    )).toThrow(/cycle/)
  })

  it('accepts only explicitly bounded feedback cycles and keeps the forward graph acyclic', () => {
    const feedback = {
      id: 'review-retry', source: 'review', target: 'draft',
      data: { orchestration: {
        route: 'success',
        condition: { path: 'json.retry', operator: 'truthy' },
        loop: { maxIterations: 3 },
      } },
    }
    expect(compileWorkflowGraph(
      [{ id: 'draft' }, { id: 'review' }],
      [{ id: 'draft-review', source: 'draft', target: 'review' }, feedback],
    )).toMatchObject({
      edges: [
        { id: 'draft-review', source: 'draft', target: 'review' },
        { id: 'review-retry', source: 'review', target: 'draft', policy: { loop: { maxIterations: 3 } } },
      ],
    })
  })

  it('rejects a loop marker that does not close a forward path', () => {
    expect(() => compileWorkflowGraph(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ source: 'a', target: 'b' }, {
        source: 'b', target: 'c',
        data: { orchestration: {
          route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 2 },
        } },
      }],
    )).toThrow(/feedback/)
  })

  it('rejects feedback regions with an external entry below the loop header', () => {
    expect(() => compileWorkflowGraph(
      [{ id: 'start' }, { id: 'draft' }, { id: 'bypass' }, { id: 'review' }],
      [
        { source: 'start', target: 'draft' },
        { source: 'start', target: 'bypass' },
        { source: 'draft', target: 'review' },
        { source: 'bypass', target: 'review' },
        { source: 'review', target: 'draft', data: { orchestration: {
          route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 2 },
        } } },
      ],
    )).toThrow(/single-entry/)
  })

  it('orders strictly nested feedback regions from outer to inner independent of edge input order', () => {
    const compiled = compileWorkflowGraph(
      [{ id: 'outer' }, { id: 'inner' }, { id: 'review' }, { id: 'finish' }],
      [
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
    )
    expect(compiled.edges.filter(edge => edge.policy.loop).map(edge => ({
      id: edge.id, order: edge.loopOrder,
    }))).toEqual([
      { id: 'review-inner', order: 1 },
      { id: 'finish-outer', order: 0 },
    ])
  })

  it('accepts disjoint bounded feedback regions', () => {
    const compiled = compileWorkflowGraph(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { id: 'a-b', source: 'a', target: 'b' },
        { id: 'b-a', source: 'b', target: 'a', data: { orchestration: {
          route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 2 },
        } } },
        { id: 'c-d', source: 'c', target: 'd' },
        { id: 'd-c', source: 'd', target: 'c', data: { orchestration: {
          route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 3 },
        } } },
      ],
    )
    expect(compiled.edges.filter(edge => edge.policy.loop).map(edge => edge.loopNodeIds)).toEqual([
      ['a', 'b'], ['c', 'd'],
    ])
  })

  it('rejects partially overlapping feedback regions', () => {
    expect(() => compileWorkflowGraph(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'd' },
        { id: 'c-a', source: 'c', target: 'a', data: { orchestration: {
          route: 'success', condition: { path: 'json.retryA', operator: 'truthy' }, loop: { maxIterations: 2 },
        } } },
        { id: 'd-b', source: 'd', target: 'b', data: { orchestration: {
          route: 'success', condition: { path: 'json.retryB', operator: 'truthy' }, loop: { maxIterations: 2 },
        } } },
      ],
    )).toThrow(/overlap/)
  })

  it.each([null, {}, { maxIterations: 0 }, { maxIterations: 1.5 }, { maxIterations: 101 }, { maxIterations: 3, extra: true }])(
    'rejects malformed feedback loop policy %j',
    (loop) => {
      expect(() => compileWorkflowGraph(
        [{ id: 'draft' }, { id: 'review' }],
        [{ source: 'draft', target: 'review' }, {
          source: 'review', target: 'draft',
          data: { orchestration: {
            route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop,
          } },
        }],
      )).toThrow(/loop/)
    },
  )

  it('rejects feedback loop policies without a condition', () => {
    expect(() => compileWorkflowGraph(
      [{ id: 'draft' }, { id: 'review' }],
      [{ source: 'draft', target: 'review' }, {
        source: 'review', target: 'draft',
        data: { orchestration: { route: 'success', loop: { maxIterations: 3 } } },
      }],
    )).toThrow(/condition/)
  })

})
