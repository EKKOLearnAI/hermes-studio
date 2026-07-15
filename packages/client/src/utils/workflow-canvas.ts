export interface CanvasState<N = any, E = any> { nodes: N[]; edges: E[] }
export interface CanvasTransaction<N = any, E = any> { before: CanvasState<N, E>; after: CanvasState<N, E> }

export function createConnectedAgentTransaction<N extends { id: string }, E = any>(
  state: CanvasState<N, E>, input: { source: string; nodeId: string; title: string; position: { x: number; y: number }; nodeData: any },
): CanvasTransaction<N, E> {
  if (!state.nodes.some(node => node.id === input.source)) throw new Error('source node does not exist')
  if (state.nodes.some(node => node.id === input.nodeId)) throw new Error('target node already exists')
  const node = { id: input.nodeId, type: 'agent', position: { ...input.position }, data: { ...input.nodeData } } as unknown as N
  const edge = { id: `edge-${input.source}-${input.nodeId}`, source: input.source, sourceHandle: 'output', target: input.nodeId, targetHandle: 'input', type: 'smoothstep' } as E
  return { before: state, after: { nodes: [...state.nodes, node], edges: [...state.edges, edge] } }
}

export function undoCanvasTransaction<N, E>(transaction: CanvasTransaction<N, E>): CanvasState<N, E> {
  return transaction.before
}
