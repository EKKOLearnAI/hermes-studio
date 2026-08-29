import { describe, expect, it } from 'vitest'
import type { EkkoMemoryNode } from '@/api/ekko/memory'
import {
  buildEkkoMemoryGraphEdges,
  ekkoMemoryNeighborIds,
  layoutEkkoMemoryGraph,
} from '@/utils/ekko/memory-graph'

function memory(id: string, overrides: Partial<EkkoMemoryNode> = {}): EkkoMemoryNode {
  return {
    id,
    profileId: 'default',
    scope: { type: 'profile' },
    domain: 'user',
    categoryPath: ['preferences'],
    type: 'preference',
    key: `key:${id}`,
    revision: 1,
    title: id,
    content: id,
    status: 'active',
    confidence: 1,
    importance: 0.8,
    tags: [],
    entities: [],
    sourceMessageIds: [],
    createdAt: `2026-01-0${id.length}T00:00:00.000Z`,
    updatedAt: `2026-01-0${id.length}T00:00:00.000Z`,
    ...overrides,
  }
}

describe('Ekko memory graph', () => {
  it('uses explicit version lineage and merges other evidence on the same edge', () => {
    const oldNode = memory('old', {
      key: 'preference:theme',
      status: 'superseded',
      entities: ['VS Code'],
      sourceMessageIds: ['message-1'],
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const newNode = memory('new', {
      key: 'preference:theme',
      revision: 2,
      parentId: 'old',
      supersedesId: 'old',
      entities: ['vs code'],
      sourceMessageIds: ['message-1'],
      createdAt: '2026-01-02T00:00:00.000Z',
    })

    expect(buildEkkoMemoryGraphEdges([newNode, oldNode])).toEqual([expect.objectContaining({
      source: 'old',
      target: 'new',
      kinds: ['revision', 'source', 'entity'],
      labels: ['message-1', 'VS Code'],
    })])
  })

  it('chains shared-source and shared-entity groups instead of creating cliques', () => {
    const nodes = [
      memory('a', { sourceMessageIds: ['m1'], entities: ['Hermes'], createdAt: '2026-01-01T00:00:00.000Z' }),
      memory('b', { sourceMessageIds: ['m1'], entities: ['Hermes'], createdAt: '2026-01-02T00:00:00.000Z' }),
      memory('c', { sourceMessageIds: ['m1'], entities: ['Hermes'], createdAt: '2026-01-03T00:00:00.000Z' }),
    ]
    const edges = buildEkkoMemoryGraphEdges(nodes)

    expect(edges).toHaveLength(2)
    expect(edges.every(edge => edge.kinds.includes('source') && edge.kinds.includes('entity'))).toBe(true)
    expect(ekkoMemoryNeighborIds('b', edges)).toEqual(new Set(['a', 'c']))
  })

  it('lays connected history left-to-right and keeps isolated memories visible', () => {
    const nodes = [
      memory('old', { key: 'same', createdAt: '2026-01-01T00:00:00.000Z' }),
      memory('new', { key: 'same', revision: 2, supersedesId: 'old', createdAt: '2026-01-02T00:00:00.000Z' }),
      memory('solo', { createdAt: '2026-01-03T00:00:00.000Z' }),
    ]
    const edges = buildEkkoMemoryGraphEdges(nodes)
    const layout = layoutEkkoMemoryGraph(nodes, edges)
    const position = (id: string) => layout.find(node => node.id === id)!.position

    expect(position('old').x).toBeLessThan(position('new').x)
    expect(layout.map(node => node.id).sort()).toEqual(['new', 'old', 'solo'])
    expect(layout.find(node => node.id === 'solo')?.degree).toBe(0)
  })

  it('is deterministic when API ordering changes', () => {
    const nodes = [
      memory('a', { sourceMessageIds: ['m1'], createdAt: '2026-01-01T00:00:00.000Z' }),
      memory('b', { sourceMessageIds: ['m1'], createdAt: '2026-01-02T00:00:00.000Z' }),
      memory('c', { createdAt: '2026-01-03T00:00:00.000Z' }),
    ]
    const firstEdges = buildEkkoMemoryGraphEdges(nodes)
    const secondEdges = buildEkkoMemoryGraphEdges([...nodes].reverse())

    expect(secondEdges).toEqual(firstEdges)
    expect(layoutEkkoMemoryGraph([...nodes].reverse(), secondEdges)).toEqual(
      layoutEkkoMemoryGraph(nodes, firstEdges),
    )
  })
})
