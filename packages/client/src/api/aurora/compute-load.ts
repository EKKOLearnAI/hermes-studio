import { request } from '@/api/client'

export interface AuroraComputeLoadTelemetry {
  generatedAt: string
  maxConcurrency: number
  activeCount: number
  queuedCount: number
  completedCount: number
  failedCount: number
  active: Array<{
    id: string
    kind: string
    priority: 'high' | 'medium' | 'low'
    startedAt: string
  }>
  queued: Array<{
    id: string
    kind: string
    priority: 'high' | 'medium' | 'low'
    enqueuedAt: string
  }>
  byPriority: Record<'high' | 'medium' | 'low', {
    active: number
    queued: number
  }>
}

export async function fetchAuroraComputeLoad(): Promise<AuroraComputeLoadTelemetry> {
  return request<AuroraComputeLoadTelemetry>('/api/aurora/compute-load')
}
