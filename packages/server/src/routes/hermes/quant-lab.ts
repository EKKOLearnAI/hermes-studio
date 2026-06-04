import Router from '@koa/router'
import type { Context } from 'koa'
import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, resolve } from 'path'

export interface QuantLabStatusResponse {
  ok: true
  feature: 'quant-lab'
  status: 'foundation'
  capabilities: string[]
}

type RollingPerformanceKey = 'wf' | 'aiBottleneck' | 'youziCycle'

interface QuantLabRollingPerformance {
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

interface QuantLabRollingPerformanceResponse {
  ok: true
  generatedAt: string
  root: string
  summaries: Record<RollingPerformanceKey, QuantLabRollingPerformance | null>
}

export const quantLabRoutes = new Router()

function resolveKnowledgeRoot(): string {
  return process.env.WIKI_PATH ||
    process.env.HERMES_KNOWLEDGE_PATH ||
    resolve(homedir(), 'Documents', 'KK-Obsidian', 'Hermes-Knowledge')
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/,/g, '').replace(/%$/, '')
  if (!normalized) return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return null
  return value.trim().endsWith('%') ? parsed / 100 : parsed
}

function parseInteger(value: unknown): number {
  const parsed = parseNumber(value)
  return Number.isFinite(parsed) ? Math.trunc(Number(parsed)) : 0
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item).trim()).filter(Boolean)
}

async function readLatestRollingPerformanceSummary(
  suffix: string,
  defaultPolicy: string,
): Promise<QuantLabRollingPerformance | null> {
  const rawDir = resolve(resolveKnowledgeRoot(), 'raw', 'market', 'quant-simulation')
  if (!existsSync(rawDir)) return null

  const files = (await readdir(rawDir))
    .filter(name => name.endsWith(suffix))
    .sort()
  const latest = files[files.length - 1]
  if (!latest) return null

  const sourceDate = latest.replace(suffix, '')
  const sourceFile = resolve(rawDir, latest)
  const raw = JSON.parse(await readFile(sourceFile, 'utf-8')) as Record<string, unknown>

  return {
    date: String(raw.date || sourceDate),
    generatedAt: String(raw.generated_at || raw.generatedAt || ''),
    policy: String(raw.policy || defaultPolicy),
    snapshotCount: parseInteger(raw.snapshot_count),
    avgReturn1d: parseNumber(raw.avg_return_1d),
    winRate1d: parseNumber(raw.win_rate_1d),
    sampleCount1d: parseInteger(raw.sample_count_1d),
    avgReturn5d: parseNumber(raw.avg_return_5d),
    winRate5d: parseNumber(raw.win_rate_5d),
    sampleCount5d: parseInteger(raw.sample_count_5d),
    avgReturn10d: parseNumber(raw.avg_return_10d),
    winRate10d: parseNumber(raw.win_rate_10d),
    sampleCount10d: parseInteger(raw.sample_count_10d),
    avgReturn20d: parseNumber(raw.avg_return_20d),
    winRate20d: parseNumber(raw.win_rate_20d),
    sampleCount20d: parseInteger(raw.sample_count_20d),
    dailySampleCount: parseInteger(raw.daily_sample_count),
    dailyAvgReturn: parseNumber(raw.daily_avg_return),
    dailyWinRate: parseNumber(raw.daily_win_rate),
    dailyVol: parseNumber(raw.daily_vol),
    dailySharpeProxy: parseNumber(raw.daily_sharpe_proxy),
    avgTurnover: parseNumber(raw.avg_turnover),
    latestTurnover: parseNumber(raw.latest_turnover),
    latestAdded: parseStringList(raw.latest_added),
    latestRemoved: parseStringList(raw.latest_removed),
    latestKept: parseStringList(raw.latest_kept),
    sourceFile: basename(sourceFile),
    sourceDate,
  }
}

async function safeReadLatestRollingPerformanceSummary(
  suffix: string,
  defaultPolicy: string,
): Promise<QuantLabRollingPerformance | null> {
  try {
    return await readLatestRollingPerformanceSummary(suffix, defaultPolicy)
  } catch {
    return null
  }
}

quantLabRoutes.get('/api/hermes/quant-lab/status', async (ctx: Context) => {
  const body: QuantLabStatusResponse = {
    ok: true,
    feature: 'quant-lab',
    status: 'foundation',
    capabilities: [
      'status',
      'rolling-performance',
    ],
  }

  ctx.body = body
})

quantLabRoutes.get('/api/hermes/quant-lab/rolling-performance', async (ctx: Context) => {
  const [wf, aiBottleneck, youziCycle] = await Promise.all([
    safeReadLatestRollingPerformanceSummary('-wf-rolling-performance-summary.json', 'wf-top5-equal-weight'),
    safeReadLatestRollingPerformanceSummary('-ai-bottleneck-rolling-performance-summary.json', 'ai-bottleneck-top5-equal-weight'),
    safeReadLatestRollingPerformanceSummary('-youzi-cycle-rolling-performance-summary.json', 'youzi-cycle-top5-equal-weight'),
  ])

  const body: QuantLabRollingPerformanceResponse = {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: resolveKnowledgeRoot(),
    summaries: {
      wf,
      aiBottleneck,
      youziCycle,
    },
  }

  ctx.body = body
})
