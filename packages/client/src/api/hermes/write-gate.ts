import { request } from '../client'

export type WriteGateSubsystem = 'memory' | 'skills'

export interface PendingWriteRecord {
  id: string
  subsystem: WriteGateSubsystem
  action: string
  summary: string
  origin: string
  created_at: number | null
  payload: Record<string, any>
}

export interface PendingWritesResponse {
  records: PendingWriteRecord[]
  counts: Record<WriteGateSubsystem, number>
}

export async function fetchPendingWrites(): Promise<PendingWritesResponse> {
  return request<PendingWritesResponse>('/api/hermes/write-gate/pending')
}

export async function fetchPendingWriteDiff(subsystem: WriteGateSubsystem, id: string): Promise<string> {
  const res = await request<{ diff: string }>(`/api/hermes/write-gate/pending/${encodeURIComponent(subsystem)}/${encodeURIComponent(id)}/diff`)
  return res.diff
}

export async function approvePendingWrite(subsystem: WriteGateSubsystem, id: string): Promise<{ output: string }> {
  return request<{ success: boolean; output: string }>(
    `/api/hermes/write-gate/pending/${encodeURIComponent(subsystem)}/${encodeURIComponent(id)}/approve`,
    { method: 'POST' },
  )
}

export async function rejectPendingWrite(subsystem: WriteGateSubsystem, id: string): Promise<{ output: string }> {
  return request<{ success: boolean; output: string }>(
    `/api/hermes/write-gate/pending/${encodeURIComponent(subsystem)}/${encodeURIComponent(id)}/reject`,
    { method: 'POST' },
  )
}
