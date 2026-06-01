import { request } from '../client'

export type SystemComponentStatus = 'ok' | 'warn' | 'error' | 'unknown'

export interface SystemStatusItem {
  key: string
  label: string
  status: SystemComponentStatus
  summary: string
  detail?: string
  url?: string
  path?: string
  pid?: number
  updated_at: string
  metadata?: Record<string, unknown>
}

export interface SystemStatusResponse {
  status: SystemComponentStatus
  checked_at: string
  profile: string
  hermes_home: string
  components: SystemStatusItem[]
}

export type SystemStatusAction =
  | 'restart-gateway'
  | 'restart-mirofish'
  | 'open-mirofish'
  | 'open-obsidian'
  | 'open-knowledge-vault'
  | 'open-latest-report'

export interface SystemStatusActionResponse {
  ok: boolean
  action: SystemStatusAction
  message: string
}

export async function fetchSystemStatus(): Promise<SystemStatusResponse> {
  return request<SystemStatusResponse>('/api/hermes/system-status')
}

export async function runSystemStatusAction(action: SystemStatusAction): Promise<SystemStatusActionResponse> {
  return request<SystemStatusActionResponse>('/api/hermes/system-status/action', {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}
