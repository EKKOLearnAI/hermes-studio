import { request } from '../client'

export interface JourneyNode {
  id: string
  label: string
  kind: 'skill' | 'memory' | string
  timestamp?: number | null
  category?: string | null
  useCount?: number
  state?: string
  createdBy?: string | null
  pinned?: boolean
  memorySource?: string
}

export interface JourneyEdge {
  source: string
  target: string
}

export interface JourneyCluster {
  category: string
  count: number
}

export interface JourneyMemory {
  source?: string
  timestamp?: number | null
  title?: string
  body?: string
}

export interface JourneyGraph {
  nodes: JourneyNode[]
  edges: JourneyEdge[]
  clusters: JourneyCluster[]
  memory?: JourneyMemory[]
  stats?: Record<string, unknown>
}

export interface JourneyGraphResponse {
  profile: string
  source: 'cli'
  graph: JourneyGraph
}

export async function fetchJourneyGraph(): Promise<JourneyGraphResponse> {
  return request<JourneyGraphResponse>('/api/hermes/journey')
}
