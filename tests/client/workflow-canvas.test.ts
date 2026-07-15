import { describe, expect, it } from 'vitest'
import { createConnectedAgentTransaction, undoCanvasTransaction } from '../../packages/client/src/utils/workflow-canvas'

describe('workflow canvas atomic transactions', () => {
  it('creates one node and one edge without copying source data', () => {
    const before = { nodes: [{ id: 'source', data: { token: 'secret' } }], edges: [] }
    const result = createConnectedAgentTransaction(before as any, { source: 'source', nodeId: 'agent-2', title: 'Agent 2', position: { x: 10, y: 20 }, nodeData: { agent: 'hermes' } })
    expect(result.after.nodes).toHaveLength(2)
    expect(result.after.edges).toEqual([expect.objectContaining({ source: 'source', target: 'agent-2' })])
    expect(result.after.nodes[1].data).toEqual({ agent: 'hermes' })
    expect(undoCanvasTransaction(result)).toEqual(before)
  })
  it('rejects an absent source atomically', () => {
    expect(() => createConnectedAgentTransaction({ nodes: [], edges: [] }, { source: 'missing', nodeId: 'agent-1', title: 'Agent', position: { x: 0, y: 0 }, nodeData: {} })).toThrow('source node does not exist')
  })
})
