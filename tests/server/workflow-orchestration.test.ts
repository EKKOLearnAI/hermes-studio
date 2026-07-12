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
})
