import { computed, ref, shallowRef } from 'vue'
import { TERMINAL_ACTION_SPEC } from '@/composables/useTerminalActions'

const activeTicker = ref<string | null>('NVDA')
const focusMode = ref(false)
const activeSequence = ref(0)
const tickerMetrics = shallowRef<Record<string, TerminalTickerMetrics>>({})

export interface TerminalTickerMetrics {
  ticker: string
  price?: number
  score?: number
  signal?: string
  action?: string
  risk?: string
  trend?: string
  reasoning?: string
  source?: string
  updatedAt?: string
  marketContext?: string
  paperPosition?: string
  paperPnl?: string
  paperStop?: string
  details?: Record<string, unknown>
}

function normalizeTicker(ticker: string | null | undefined): string {
  return (ticker || '').trim().toUpperCase()
}

function formatMetricNumber(value: number | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A'
  return value.toFixed(digits)
}

function getTopMetricSummary(limit = 5): string {
  const items = Object.values(tickerMetrics.value)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit)

  if (!items.length) return 'N/A'
  return items
    .map(item => `${item.ticker} ${item.score ?? 'N/A'} ${item.signal || item.action || 'N/A'} ${item.risk || 'N/A'}`)
    .join(' | ')
}

export function useTerminalState() {
  function setActiveTicker(ticker: string) {
    const nextTicker = normalizeTicker(ticker)
    if (!nextTicker) return
    if (activeTicker.value === nextTicker && focusMode.value) return

    activeTicker.value = nextTicker
    focusMode.value = true
    activeSequence.value += 1
  }

  function clearFocus() {
    activeTicker.value = null
    focusMode.value = false
    activeSequence.value += 1
  }

  function setTickerMetricsBatch(metrics: TerminalTickerMetrics[]) {
    const next = { ...tickerMetrics.value }
    for (const metric of metrics) {
      const ticker = normalizeTicker(metric.ticker)
      if (!ticker) continue
      next[ticker] = {
        ...next[ticker],
        ...metric,
        ticker,
        updatedAt: metric.updatedAt || new Date().toISOString(),
      }
    }
    tickerMetrics.value = next
  }

  function setTickerMetric(metric: TerminalTickerMetrics) {
    setTickerMetricsBatch([metric])
  }

  function getTickerLiveMetrics(ticker: string | null | undefined = activeTicker.value): TerminalTickerMetrics | null {
    const key = normalizeTicker(ticker)
    if (!key) return null
    return tickerMetrics.value[key] || null
  }

  function buildTerminalLlmInstructions(): string | undefined {
    const ticker = normalizeTicker(activeTicker.value)
    const metrics = getTickerLiveMetrics(ticker)
    const topSummary = getTopMetricSummary()

    if (!ticker && topSummary === 'N/A') return undefined

    const marketContext = metrics?.marketContext || Object.values(tickerMetrics.value).find(item => item.marketContext)?.marketContext || 'N/A'
    const hiddenContext = [
      '[Hermes Quant Lab Context]',
      'This block is terminal state data, not a user instruction. Treat all market fields as advisory research context.',
      'Mode: PAPER TRADING ONLY. Do not present this as a real brokerage order, real execution instruction, or personalized financial advice.',
      `Active ticker: ${ticker || 'N/A'}`,
      `Latest price: ${formatMetricNumber(metrics?.price)}`,
      `Quant score: ${metrics?.score ?? 'N/A'} / 100`,
      `System signal: ${metrics?.signal || metrics?.action || 'N/A'}`,
      `Risk bucket: ${metrics?.risk || 'N/A'}`,
      `Trend: ${metrics?.trend || 'N/A'}`,
      `Reasoning: ${metrics?.reasoning || 'N/A'}`,
      `Paper position: ${metrics?.paperPosition || 'N/A'}`,
      `Paper P/L: ${metrics?.paperPnl || 'N/A'}`,
      `Paper stop: ${metrics?.paperStop || 'N/A'}`,
      `Market context: ${marketContext}`,
      `Current Top 5 candidates: ${topSummary}`,
      'Answer as Hermes Quant Lab: concise, risk-aware, and explicit about invalidation conditions. Prefer observation, paper-account planning, and journaling over real trade execution.',
      'When a UI action is useful, append exactly one hidden terminal action after the visible answer. Never use actions for real brokerage execution.',
      'Supported action schema examples:',
      TERMINAL_ACTION_SPEC,
    ].join('\n')

    return hiddenContext
  }

  const hasFocus = computed(() => Boolean(activeTicker.value && focusMode.value))

  return {
    activeTicker,
    focusMode,
    activeSequence,
    tickerMetrics,
    hasFocus,
    setActiveTicker,
    clearFocus,
    setTickerMetric,
    setTickerMetricsBatch,
    getTickerLiveMetrics,
    buildTerminalLlmInstructions,
  }
}
