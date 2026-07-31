import type { JourneyEdge, JourneyNode } from '@/api/hermes/journey'

export type JourneyNodeColumn = 'memory' | 'skill'

export interface JourneyLayoutNode {
  id: string
  column: JourneyNodeColumn
  degree: number
  position: {
    x: number
    y: number
  }
}

export interface JourneyLayoutOptions {
  memoryX?: number
  skillX?: number
  verticalGap?: number
  columnGap?: number
  groupGap?: number
  maxRows?: number
}

const DEFAULT_MEMORY_X = 80
const DEFAULT_VERTICAL_GAP = 112
const DEFAULT_COLUMN_GAP = 290
const DEFAULT_GROUP_GAP = 200
const DEFAULT_MAX_ROWS = 8

function baseNodeCompare(a: JourneyNode, b: JourneyNode): number {
  const aTime = a.timestamp
  const bTime = b.timestamp
  if (aTime && bTime && aTime !== bTime) return aTime - bTime
  if (aTime && !bTime) return -1
  if (!aTime && bTime) return 1

  const categoryOrder = (a.category || '').localeCompare(b.category || '')
  if (categoryOrder !== 0) return categoryOrder

  const labelOrder = (a.label || '').localeCompare(b.label || '')
  if (labelOrder !== 0) return labelOrder
  return a.id.localeCompare(b.id)
}

function neighborMap(edges: JourneyEdge[]): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>()
  const connect = (source: string, target: string) => {
    const current = neighbors.get(source) || new Set<string>()
    current.add(target)
    neighbors.set(source, current)
  }

  for (const edge of edges) {
    connect(edge.source, edge.target)
    connect(edge.target, edge.source)
  }
  return neighbors
}

function normalizedIndexMap(nodes: JourneyNode[]): Map<string, number> {
  const denominator = Math.max(1, nodes.length - 1)
  return new Map(nodes.map((node, index) => [node.id, index / denominator]))
}

function barycenter(
  node: JourneyNode,
  oppositeIndex: Map<string, number>,
  neighbors: Map<string, Set<string>>,
): number | null {
  const positions = [...(neighbors.get(node.id) || [])]
    .map(id => oppositeIndex.get(id))
    .filter((value): value is number => value !== undefined)
  if (!positions.length) return null
  return positions.reduce((sum, value) => sum + value, 0) / positions.length
}

function reorderByNeighbors(
  nodes: JourneyNode[],
  oppositeNodes: JourneyNode[],
  neighbors: Map<string, Set<string>>,
): JourneyNode[] {
  const oppositeIndex = normalizedIndexMap(oppositeNodes)
  return [...nodes].sort((a, b) => {
    const aCenter = barycenter(a, oppositeIndex, neighbors)
    const bCenter = barycenter(b, oppositeIndex, neighbors)
    if (aCenter !== null && bCenter !== null && aCenter !== bCenter) return aCenter - bCenter
    if (aCenter !== null && bCenter === null) return -1
    if (aCenter === null && bCenter !== null) return 1
    return baseNodeCompare(a, b)
  })
}

function gridPosition(
  index: number,
  count: number,
  rowCount: number,
  startX: number,
  columnGap: number,
  verticalGap: number,
): { x: number; y: number } {
  const column = Math.floor(index / rowCount)
  const row = index % rowCount
  const columnStart = column * rowCount
  const nodesInColumn = Math.min(rowCount, count - columnStart)
  const verticalOffset = ((rowCount - nodesInColumn) * verticalGap) / 2
  return {
    x: startX + column * columnGap,
    y: verticalOffset + row * verticalGap,
  }
}

/**
 * Produces a deterministic two-column layout for Journey's bipartite
 * memory-to-skill graph. A few barycentric passes keep related nodes close
 * together and substantially reduce crossings without a runtime layout engine.
 */
export function layoutJourneyGraph(
  nodes: JourneyNode[],
  edges: JourneyEdge[],
  options: JourneyLayoutOptions = {},
): JourneyLayoutNode[] {
  const nodeIds = new Set(nodes.map(node => node.id))
  const validEdges = edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  const neighbors = neighborMap(validEdges)

  let memories = nodes.filter(node => node.kind === 'memory').sort(baseNodeCompare)
  let skills = nodes.filter(node => node.kind !== 'memory').sort(baseNodeCompare)

  for (let pass = 0; pass < 3; pass += 1) {
    skills = reorderByNeighbors(skills, memories, neighbors)
    memories = reorderByNeighbors(memories, skills, neighbors)
  }

  const memoryX = options.memoryX ?? DEFAULT_MEMORY_X
  const verticalGap = options.verticalGap ?? DEFAULT_VERTICAL_GAP
  const columnGap = options.columnGap ?? DEFAULT_COLUMN_GAP
  const groupGap = options.groupGap ?? DEFAULT_GROUP_GAP
  const maxCount = Math.max(1, memories.length, skills.length)
  const rowCount = Math.max(1, Math.min(options.maxRows ?? DEFAULT_MAX_ROWS, maxCount))
  const memoryColumnCount = Math.max(1, Math.ceil(memories.length / rowCount))
  const skillX = memories.length
    ? options.skillX ?? memoryX + memoryColumnCount * columnGap + groupGap
    : memoryX

  const toLayoutNode = (
    node: JourneyNode,
    index: number,
    column: JourneyNodeColumn,
    count: number,
    startX: number,
  ): JourneyLayoutNode => ({
    id: node.id,
    column,
    degree: neighbors.get(node.id)?.size || 0,
    position: gridPosition(index, count, rowCount, startX, columnGap, verticalGap),
  })

  return [
    ...memories.map((node, index) => toLayoutNode(node, index, 'memory', memories.length, memoryX)),
    ...skills.map((node, index) => toLayoutNode(node, index, 'skill', skills.length, skillX)),
  ]
}

export function journeyNeighborIds(nodeId: string, edges: JourneyEdge[]): Set<string> {
  const neighbors = new Set<string>()
  for (const edge of edges) {
    if (edge.source === nodeId) neighbors.add(edge.target)
    if (edge.target === nodeId) neighbors.add(edge.source)
  }
  return neighbors
}
