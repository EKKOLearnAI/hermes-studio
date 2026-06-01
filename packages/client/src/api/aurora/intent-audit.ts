import { request } from '@/api/client'
import type { AuroraIntentAuditRecord } from '@/stores/hermes/aurora-intent-audit'

export interface AuroraIntentAuditResponse {
  generatedAt: string
  storage: 'server'
  records: AuroraIntentAuditRecord[]
}

export interface AuroraIntentAuditWriteResponse {
  ok: boolean
  record: AuroraIntentAuditRecord
  count: number
}

export function fetchAuroraIntentAudit(limit = 50): Promise<AuroraIntentAuditResponse> {
  return request<AuroraIntentAuditResponse>(`/api/aurora/intent-audit?limit=${encodeURIComponent(String(limit))}`)
}

export function writeAuroraIntentAuditRecord(
  record: AuroraIntentAuditRecord,
): Promise<AuroraIntentAuditWriteResponse> {
  return request<AuroraIntentAuditWriteResponse>('/api/aurora/intent-audit', {
    method: 'POST',
    body: JSON.stringify({ record }),
  })
}

export function clearAuroraIntentAudit(): Promise<{ ok: boolean; count: number }> {
  return request<{ ok: boolean; count: number }>('/api/aurora/intent-audit', {
    method: 'DELETE',
  })
}
