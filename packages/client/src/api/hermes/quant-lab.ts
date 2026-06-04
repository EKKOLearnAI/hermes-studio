import { request } from '../client'

export interface QuantLabStatus {
  ok: boolean
  feature: 'quant-lab'
  status: 'foundation'
  capabilities: string[]
}

export async function fetchQuantLabStatus(): Promise<QuantLabStatus> {
  return request<QuantLabStatus>('/api/hermes/quant-lab/status')
}
