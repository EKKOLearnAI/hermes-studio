import { describe, expect, it } from 'vitest'
import type { JourneyEdge, JourneyNode } from '@/api/hermes/journey'
import { journeyNeighborIds, layoutJourneyGraph } from '@/utils/hermes/journey-layout'

function node(id: string, kind: 'memory' | 'skill', timestamp: number): JourneyNode {
  return {
    id,
    kind,
    timestamp,
    label: id,
    category: kind,
  }
}

describe('journey layout', () => {
  it('places memories left of skills and spreads both columns across the same height', () => {
    const nodes = [
      node('memory:1', 'memory', 1),
      node('memory:2', 'memory', 2),
      node('memory:3', 'memory', 3),
      node('skill:1', 'skill', 4),
      node('skill:2', 'skill', 5),
    ]
    const layout = layoutJourneyGraph(nodes, [])
    const memories = layout.filter(item => item.column === 'memory')
    const skills = layout.filter(item => item.column === 'skill')

    expect(memories.every(item => item.position.x < skills[0].position.x)).toBe(true)
    expect(memories.map(item => item.position.y)).toEqual([0, 112, 224])
    expect(skills.map(item => item.position.y)).toEqual([56, 168])
  })

  it('uses neighbor barycenters to keep related nodes close together deterministically', () => {
    const nodes = [
      node('memory:a', 'memory', 1),
      node('memory:b', 'memory', 2),
      node('skill:b', 'skill', 3),
      node('skill:a', 'skill', 4),
    ]
    const edges: JourneyEdge[] = [
      { source: 'memory:a', target: 'skill:a' },
      { source: 'memory:b', target: 'skill:b' },
    ]

    const first = layoutJourneyGraph(nodes, edges)
    const second = layoutJourneyGraph([...nodes].reverse(), [...edges].reverse())
    const position = (layout: typeof first, id: string) => layout.find(item => item.id === id)!.position.y

    expect(position(first, 'memory:a')).toBe(position(first, 'skill:a'))
    expect(position(first, 'memory:b')).toBe(position(first, 'skill:b'))
    expect(first).toEqual(second)
  })

  it('counts unique neighbors and ignores edges whose nodes are absent', () => {
    const nodes = [
      node('memory:1', 'memory', 1),
      node('skill:1', 'skill', 2),
    ]
    const edges: JourneyEdge[] = [
      { source: 'memory:1', target: 'skill:1' },
      { source: 'memory:1', target: 'skill:1' },
      { source: 'memory:missing', target: 'skill:1' },
    ]
    const layout = layoutJourneyGraph(nodes, edges)

    expect(layout.find(item => item.id === 'memory:1')?.degree).toBe(1)
    expect(layout.find(item => item.id === 'skill:1')?.degree).toBe(1)
    expect(journeyNeighborIds('memory:1', edges)).toEqual(new Set(['skill:1']))
  })

  it('centers a single node against a taller opposite column', () => {
    const nodes = [
      node('memory:1', 'memory', 1),
      node('memory:2', 'memory', 2),
      node('memory:3', 'memory', 3),
      node('skill:1', 'skill', 4),
    ]
    const layout = layoutJourneyGraph(nodes, [])

    expect(layout.find(item => item.id === 'skill:1')?.position.y).toBe(112)
  })

  it('wraps long columns horizontally at the configured row limit', () => {
    const nodes = Array.from({ length: 7 }, (_, index) =>
      node(`memory:${index}`, 'memory', index + 1))
    nodes.push(node('skill:1', 'skill', 20))

    const layout = layoutJourneyGraph(nodes, [], { maxRows: 3 })
    const memories = layout.filter(item => item.column === 'memory')
    const distinctX = new Set(memories.map(item => item.position.x))

    expect(distinctX.size).toBe(3)
    expect(Math.max(...memories.map(item => item.position.y))).toBe(224)
    expect(layout.find(item => item.id === 'skill:1')!.position.x).toBeGreaterThan(
      Math.max(...memories.map(item => item.position.x)),
    )
  })
})
