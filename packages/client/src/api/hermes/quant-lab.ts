import { request } from '../client'

export interface QuantLabStatus {
  ok: boolean
  feature: 'quant-lab'
  status: 'foundation'
  capabilities: string[]
}

export interface QuantLabRollingPerformance {
  date: string
  generatedAt: string
  policy: string
  snapshotCount: number
  avgReturn1d: number | null
  winRate1d: number | null
  sampleCount1d: number
  avgReturn5d: number | null
  winRate5d: number | null
  sampleCount5d: number
  avgReturn10d: number | null
  winRate10d: number | null
  sampleCount10d: number
  avgReturn20d: number | null
  winRate20d: number | null
  sampleCount20d: number
  dailySampleCount: number
  dailyAvgReturn: number | null
  dailyWinRate: number | null
  dailyVol: number | null
  dailySharpeProxy: number | null
  avgTurnover: number | null
  latestTurnover: number | null
  latestAdded: string[]
  latestRemoved: string[]
  latestKept: string[]
  sourceFile: string
  sourceDate: string
}

export interface QuantLabRollingPerformanceResponse {
  ok: boolean
  generatedAt: string
  root: string
  summaries: {
    wf: QuantLabRollingPerformance | null
    aiBottleneck: QuantLabRollingPerformance | null
    youziCycle: QuantLabRollingPerformance | null
  }
}

export async function fetchQuantLabStatus(): Promise<QuantLabStatus> {
  return request<QuantLabStatus>('/api/hermes/quant-lab/status')
}

export async function fetchQuantLabRollingPerformance(): Promise<QuantLabRollingPerformanceResponse> {
  return request<QuantLabRollingPerformanceResponse>('/api/hermes/quant-lab/rolling-performance')
}
