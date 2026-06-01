import { request } from '@/api/client'
import type { LifeOsState } from '@/api/hermes/life-os'

export interface NexusEvaluateResponse {
  advice: string
  mode?: 'hermes-gateway' | 'custom-provider' | 'local-fallback'
  knowledgeKeywords?: string[]
  knowledgeContextFound?: boolean
  marketIntelSymbols?: string[]
  openClawContextFound?: boolean
  breachedBudgets?: string[]
}

export function evaluateNexus(currentFinancialState: LifeOsState): Promise<NexusEvaluateResponse> {
  return request<NexusEvaluateResponse>('/api/nexus/evaluate', {
    method: 'POST',
    body: JSON.stringify({ currentFinancialState }),
  })
}
