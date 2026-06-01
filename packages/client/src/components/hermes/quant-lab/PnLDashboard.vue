<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { AreaSeries, ColorType, CrosshairMode, createChart } from 'lightweight-charts'
import type { AreaData, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import {
  getQuantLabPaperTrades,
  type QuantLabPaperEquityPoint,
  type QuantLabPaperTrade,
  type QuantLabPaperTradesResult,
} from '@/api/hermes/quant-lab'

const NEON_GREEN = '#00ff88'

const loading = ref(false)
const error = ref('')
const account = ref<QuantLabPaperTradesResult['account'] | null>(null)
const trades = ref<QuantLabPaperTrade[]>([])
const equityCurve = ref<QuantLabPaperEquityPoint[]>([])
const chartContainer = ref<HTMLElement | null>(null)

let chart: IChartApi | null = null
let areaSeries: ISeriesApi<'Area'> | null = null
let resizeObserver: ResizeObserver | null = null

async function fetchPaperTrades(): Promise<QuantLabPaperTradesResult> {
  return getQuantLabPaperTrades()
}

async function loadPaperTrades() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetchPaperTrades()
    account.value = response.account
    trades.value = response.trades || []
    equityCurve.value = normalizeEquityCurve(response.equityCurve || [])
    await nextTick()
    updateChart()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '讀取紙上交易績效失敗'
  } finally {
    loading.value = false
  }
}

const nav = computed(() => account.value?.equity ?? latestEquity.value ?? 0)
const winRate = computed(() => account.value?.winRate ?? calculateWinRate(trades.value))
const profitFactor = computed(() => account.value?.profitFactor ?? calculateProfitFactor(trades.value))
const maxDrawdown = computed(() => account.value?.maxDrawdownPct ?? calculateMaxDrawdown(equityCurve.value))
const latestEquity = computed(() => equityCurve.value[equityCurve.value.length - 1]?.value ?? null)
const tableRows = computed(() => trades.value.slice(0, 40))

const metrics = computed(() => [
  {
    label: 'NAV 淨值',
    value: formatCurrency(nav.value),
    tone: nav.value >= (account.value?.initialCapital ?? 1000) ? 'positive' : 'negative',
  },
  {
    label: '勝率',
    value: `${winRate.value.toFixed(1)}%`,
    tone: winRate.value >= 50 ? 'positive' : 'negative',
  },
  {
    label: '獲利因子',
    value: profitFactor.value === null ? '∞' : profitFactor.value.toFixed(2),
    tone: profitFactor.value === null || profitFactor.value >= 1 ? 'positive' : 'negative',
  },
  {
    label: '最大回撤',
    value: `${maxDrawdown.value.toFixed(2)}%`,
    tone: Math.abs(maxDrawdown.value) > 5 ? 'negative' : 'positive',
  },
])

function calculateProfitFactor(rows: QuantLabPaperTrade[]): number | null {
  const grossProfit = rows.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0)
  const grossLoss = Math.abs(rows.filter(row => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0))
  if (grossLoss === 0) return grossProfit > 0 ? null : 0
  return grossProfit / grossLoss
}

function calculateMaxDrawdown(points: QuantLabPaperEquityPoint[]): number {
  let peak = 0
  let worst = 0
  for (const point of points) {
    peak = Math.max(peak, point.value)
    if (peak > 0) worst = Math.min(worst, ((point.value - peak) / peak) * 100)
  }
  return worst
}

function calculateWinRate(rows: QuantLabPaperTrade[]): number {
  if (!rows.length) return 0
  return (rows.filter(row => row.pnl > 0).length / rows.length) * 100
}

function normalizeEquityCurve(points: QuantLabPaperEquityPoint[]): QuantLabPaperEquityPoint[] {
  return points
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value))
    .map(point => ({ time: Math.floor(point.time), value: Number(point.value.toFixed(2)) }))
    .sort((a, b) => a.time - b.time)
}

function chartData(): AreaData[] {
  return equityCurve.value.map(point => ({
    time: point.time as UTCTimestamp,
    value: point.value,
  }))
}

function mountChart() {
  const el = chartContainer.value
  if (!el || chart) return

  const rect = el.getBoundingClientRect()
  chart = createChart(el, {
    width: Math.max(260, Math.floor(rect.width)),
    height: Math.max(180, Math.floor(rect.height)),
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#6b7280',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    grid: {
      vertLines: { color: '#111111' },
      horzLines: { color: '#111111' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#333333', labelBackgroundColor: '#050505' },
      horzLine: { color: '#333333', labelBackgroundColor: '#050505' },
    },
    rightPriceScale: {
      borderColor: '#1f2937',
      scaleMargins: { top: 0.12, bottom: 0.12 },
    },
    timeScale: {
      borderColor: '#1f2937',
      timeVisible: true,
      secondsVisible: false,
      fixLeftEdge: false,
      fixRightEdge: false,
    },
    localization: {
      priceFormatter: (price: number) => `$${price.toFixed(2)}`,
    },
  })

  areaSeries = chart.addSeries(AreaSeries, {
    lineColor: NEON_GREEN,
    topColor: 'rgba(0, 255, 136, 0.45)',
    bottomColor: 'rgba(0, 255, 136, 0.02)',
    lineWidth: 2,
    priceLineColor: '#ffd700',
    lastValueVisible: true,
  })

  updateChart()
  resizeObserver = new ResizeObserver(resizeChart)
  resizeObserver.observe(el)
}

function updateChart() {
  if (!areaSeries) return
  areaSeries.setData(chartData())
  chart?.timeScale().fitContent()
}

function resizeChart() {
  const el = chartContainer.value
  if (!chart || !el) return
  const rect = el.getBoundingClientRect()
  chart.resize(Math.max(260, Math.floor(rect.width)), Math.max(180, Math.floor(rect.height)))
}

function formatCurrency(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '$0.00'
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPrice(value: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  return formatCurrency(value)
}

function formatPnl(value: number) {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatHolding(seconds: number | null) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'n/a'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}時`
  if (hours > 0) return `${hours}時 ${minutes}分`
  return `${minutes}分`
}

function pnlClass(value: number) {
  if (value > 0) return 'positive'
  if (value < 0) return 'negative'
  return 'neutral'
}

onMounted(async () => {
  await nextTick()
  mountChart()
  await loadPaperTrades()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.remove()
  chart = null
  areaSeries = null
})

defineExpose({ fetchPaperTrades, loadPaperTrades })
</script>

<template>
  <section class="pnl-dashboard">
    <header class="pnl-header">
      <div>
        <span>紙上績效</span>
        <strong>{{ trades.length }} 筆平倉</strong>
      </div>
      <button type="button" :disabled="loading" @click="loadPaperTrades">
        {{ loading ? '讀取中' : '刷新' }}
      </button>
    </header>

    <div v-if="error" class="pnl-error">{{ error }}</div>

    <div class="metrics-row">
      <div v-for="item in metrics" :key="item.label" class="metric-box">
        <span>{{ item.label }}</span>
        <strong :class="item.tone">{{ item.value }}</strong>
      </div>
    </div>

    <section class="curve-row">
      <div class="section-title">
        <span>資金曲線</span>
        <strong>Time-based NAV</strong>
      </div>
      <div ref="chartContainer" class="chart-container" />
    </section>

    <section class="trades-row">
      <div class="section-title">
        <span>交易明細</span>
        <strong>{{ tableRows.length }} rows</strong>
      </div>
      <table>
        <thead>
          <tr>
            <th>標的</th>
            <th>進場價</th>
            <th>出場價</th>
            <th>損益 (%)</th>
            <th>持倉時間</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="trade in tableRows" :key="trade.id">
            <td><strong>{{ trade.ticker }}</strong></td>
            <td>{{ formatPrice(trade.entryPrice) }}</td>
            <td>{{ formatPrice(trade.exitPrice) }}</td>
            <td :class="pnlClass(trade.pnlPct)">{{ formatPnl(trade.pnlPct) }}</td>
            <td>{{ formatHolding(trade.holdingSeconds) }}</td>
          </tr>
          <tr v-if="!tableRows.length">
            <td colspan="5" class="empty-cell">尚無已平倉紙上交易。完成 SELL 後會顯示績效。</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<style scoped>
.pnl-dashboard {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(96px, 0.18fr) minmax(220px, 0.46fr) minmax(180px, 0.36fr);
  background: #050505;
  color: #d1d5db;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.pnl-header,
.metric-box,
.curve-row,
.trades-row {
  border: 1px solid #1f2937;
  border-radius: 0;
  background: #050505;
}

.pnl-header {
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
}

.pnl-header span,
.metric-box span,
.section-title span,
th {
  color: #6b7280;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.pnl-header strong,
.section-title strong {
  color: #e5e7eb;
  font-size: 11px;
}

button {
  height: 24px;
  padding: 0 12px;
  border: 1px solid #1f2937;
  border-radius: 0;
  background: #050505;
  color: #9ca3af;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}

button:hover:not(:disabled) {
  color: #00ff88;
  border-color: #00ff88;
}

button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.pnl-error {
  padding: 8px 10px;
  border: 1px solid #3f0b18;
  color: #ff365e;
  font-size: 11px;
}

.metrics-row {
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.metric-box {
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
}

.metric-box strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: clamp(24px, 3vw, 42px);
  line-height: 1;
}

.curve-row,
.trades-row {
  min-height: 0;
  display: grid;
  grid-template-rows: 30px 1fr;
}

.section-title {
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 10px;
  border-bottom: 1px solid #1f2937;
}

.chart-container {
  min-height: 0;
  width: 100%;
  height: 100%;
  background: #050505;
}

.trades-row {
  overflow: hidden;
}

table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  background: transparent;
}

th,
td {
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid #1f2937;
  color: #d1d5db;
  font-size: 11px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

td strong {
  color: #f3f4f6;
}

.positive {
  color: #00ff88 !important;
}

.negative {
  color: #ff365e !important;
}

.neutral {
  color: #9ca3af !important;
}

.empty-cell {
  color: #6b7280;
  text-align: center;
}

@media (max-width: 900px) {
  .metrics-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .metric-box strong {
    font-size: 24px;
  }
}
</style>
