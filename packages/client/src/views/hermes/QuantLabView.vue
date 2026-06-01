<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { getQuantLabCandles, getQuantLabEvidenceArchives, getQuantLabMiroFishGraphSummary, getQuantLabMiroFishTaskStatus, getQuantLabPaperAccount, getQuantLabPhaseValidation, getQuantLabProviderSettings, getQuantLabSnapshot, runQuantLabBrief, runQuantLabMiroFish, runQuantLabWeeklySummary, saveQuantLabProviderSettings, saveQuantLabReport, sendQuantLabTelegram, testQuantLabProviderFeeds, updateQuantLabPaperAccount } from '@/api/hermes/quant-lab'
import QuantTerminal from '@/components/hermes/quant-lab/QuantTerminal.vue'
import { buildQuantSocketUrl, useQuantSocket } from '@/composables/useQuantSocket'
import { useTerminalState, type TerminalTickerMetrics } from '@/composables/useTerminalState'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import type {
  QuantLabBacktest,
  QuantLabCandleBar,
  QuantLabCandleTimeframe,
  QuantLabDataHealth,
  QuantLabDataTruthItem,
  QuantLabBriefPhase,
  QuantLabDecision,
  QuantLabEvidenceArchiveEntry,
  QuantLabMarketPulseItem,
  QuantLabMiroFishGraphSummary,
  QuantLabMiroFishGraphTaskStatus,
  QuantLabPaperGuardrails,
  QuantLabPhaseValidationReport,
  QuantLabMiroFishInference,
  QuantLabMiroFishSeed,
  QuantLabProviderSettings,
  QuantLabProviderTestResult,
  QuantLabTopPick,
  QuantLabWfRollingPerformance,
  SaveQuantLabProviderSettingsPayload,
} from '@/api/hermes/quant-lab'

type MainView = 'price' | 'mirofish' | 'backtest'
type LabSection = 'overview' | 'top10' | 'journal' | 'backtest' | 'risk'
type TradeAction = 'BUY' | 'SELL' | 'HOLD' | 'WATCH' | 'RESET' | 'MARK'
type JournalFilter = 'all' | 'trade' | 'watch' | 'guard' | 'system'
type TopPick = QuantLabTopPick
type PhaseValidationTone = 'up' | 'down' | 'warn' | 'neutral'

interface PhaseValidationDisplayItem {
  label: string
  value: string
  detail: string
  tone: PhaseValidationTone
}

interface PaperPosition {
  ticker: string
  shares: number
  avgCost: number
  lastPrice: number
  stop: string
}

interface JournalEntry {
  id: string
  time: string
  ticker: string
  action: TradeAction
  note: string
}

interface PaperAccountState {
  initialCapital: number
  cash: number
  realizedPnl: number
  maxEquity: number
  tradeCount: number
  wins: number
  losses: number
  grossProfit: number
  grossLoss: number
  positions: PaperPosition[]
  journal: JournalEntry[]
  equity?: number
  returnPct?: number
  dailyReturnPct?: number
  maxDrawdownPct?: number
  winRate?: number
  profitFactor?: number | null
  valuationSource?: 'server' | 'stream' | 'local'
  valuationUpdatedAt?: string
}

const activeView = ref<MainView>('price')
const activeSection = ref<LabSection>('overview')
const savingReport = ref(false)
const sendingTelegram = ref(false)
const loadingSnapshot = ref(false)
const runningBrief = ref<QuantLabBriefPhase | null>(null)
const runningWeeklySummary = ref(false)
const runningMiroFish = ref(false)
const paperActionPending = ref('')
const saveStatus = ref('')
const telegramStatus = ref('')
const briefStatus = ref('')
const journalFilter = ref<JournalFilter>('all')
const STORAGE_KEY = 'hermes_quant_lab_paper_account_v1'
const INITIAL_CAPITAL = 1000
const MAX_POSITIONS = 5

const sectionTabs: Array<{ key: LabSection; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'top10', label: 'Top 10' },
  { key: 'journal', label: 'Journal' },
  { key: 'backtest', label: 'Backtest' },
  { key: 'risk', label: 'Risk' },
]

const journalFilterOptions: Array<{ key: JournalFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'trade', label: 'Trade' },
  { key: 'watch', label: 'Watch' },
  { key: 'guard', label: 'Guard' },
  { key: 'system', label: 'System' },
]

const DEFAULT_MARKET_PULSE: QuantLabMarketPulseItem[] = [
  { label: 'SPY', value: '+0.42%', tone: 'up' },
  { label: 'QQQ', value: '+0.61%', tone: 'up' },
  { label: 'VIX', value: '14.8 -3.1%', tone: 'down' },
  { label: '10Y', value: '4.31% +0.04', tone: 'warn' },
  { label: 'DXY', value: '104.2 -0.18%', tone: 'down' },
  { label: 'Oil', value: '78.4 +0.7%', tone: 'up' },
  { label: 'Regime', value: 'Risk-on', tone: 'neutral' },
]

const DEFAULT_TOP_PICKS: TopPick[] = [
  { ticker: 'NVDA', score: 92, action: 'BUY', trend: '+2.8%', risk: 'M', reason: 'AI demand / 20MA support', price: 942.08 },
  { ticker: 'MSFT', score: 89, action: 'HOLD', trend: '+1.1%', risk: 'L', reason: 'quality compounder', price: 426.99 },
  { ticker: 'AVGO', score: 87, action: 'BUY', trend: '+2.0%', risk: 'M', reason: 'semis flow / earnings strength', price: 1364.85 },
  { ticker: 'GOOGL', score: 86, action: 'WATCH', trend: '+0.9%', risk: 'M', reason: 'ad cycle recovery', price: 178.42 },
  { ticker: 'META', score: 84, action: 'WATCH', trend: '+0.6%', risk: 'M', reason: 'margin expansion', price: 521.34 },
  { ticker: 'COST', score: 82, action: 'HOLD', trend: '+0.4%', risk: 'L', reason: 'defensive growth', price: 884.1 },
  { ticker: 'LLY', score: 81, action: 'WATCH', trend: '-0.2%', risk: 'M', reason: 'GLP-1 leadership', price: 792.45 },
  { ticker: 'AMD', score: 80, action: 'WATCH', trend: '+1.4%', risk: 'H', reason: 'breakout pending', price: 162.18 },
  { ticker: 'JPM', score: 79, action: 'HOLD', trend: '+0.3%', risk: 'L', reason: 'rate sensitivity', price: 221.2 },
  { ticker: 'AMZN', score: 78, action: 'WATCH', trend: '+0.5%', risk: 'M', reason: 'cloud acceleration', price: 187.73 },
]

const DEFAULT_RISK_RULES = [
  'Max single name: 20%',
  'Max positions: 5',
  'Max daily loss: 2%',
  'Max portfolio drawdown: 10%',
  'No leverage / no options',
]

const DEFAULT_DECISION: QuantLabDecision = {
  conclusion: '偏多，但不追高。新增部位只允許半倉，半導體仍是主線，10Y 上行是主要壓力。',
  action: 'NVDA / AVGO 可買入候選；MSFT / COST 保留；META / AMD 等待突破確認。',
  invalidation: 'VIX 升破 20、QQQ 跌破 20MA，或 10Y 連三日走高時停止新增買入。',
}

const DEFAULT_CHART_CAPTION = [
  'Portfolio beta: 1.06',
  'Market regime: risk-on with 10Y pressure',
  'Signal age: 2 sessions',
]

const DEFAULT_GRAPH_CAPTION = [
  'Scenario: semis strength spreads into mega-cap tech',
  'Conflict: rising yields cap multiple expansion',
]

const DEFAULT_BACKTESTS: QuantLabBacktest[] = [
  { strategy: 'Quality Momentum 20/60', cagr: '18.4%', sharpe: '1.18', maxDd: '-14.2%', win: '58%', status: 'Active' },
  { strategy: 'Earnings Drift', cagr: '14.1%', sharpe: '0.92', maxDd: '-17.6%', win: '54%', status: 'Watch' },
  { strategy: 'Risk-off Defensive', cagr: '9.6%', sharpe: '0.74', maxDd: '-8.1%', win: '61%', status: 'Hedge' },
]

const DEFAULT_BACKTEST_SUMMARY = [
  'Best fit: risk-on, VIX below 18, QQQ above 50MA',
  'Failure condition: VIX above 22 or 10Y breaks higher for 3 sessions',
]

const DEFAULT_DATA_HEALTH: QuantLabDataHealth = {
  status: 'FALLBACK',
  quoteSource: 'local fallback',
  quoteProvider: 'local fallback',
  quoteCoverage: '0/0',
  quoteLatencyMs: 0,
  missingSymbols: [],
  staleSymbols: [],
  fallbackSymbols: [],
  fallbackUsed: true,
  delayed: false,
  providerChain: ['local fallback'],
  providerErrors: [],
  providerStatus: [
    { provider: 'alpaca', configured: false, status: 'missing-key', detail: 'Set ALPACA_API_KEY/APCA_API_KEY_ID and ALPACA_SECRET_KEY/APCA_API_SECRET_KEY.' },
    { provider: 'polygon', configured: false, status: 'missing-key', detail: 'Set POLYGON_API_KEY.' },
  ],
  dataTruth: [
    { area: 'Quotes', mode: 'mock', source: 'local fallback', detail: 'No real quote provider loaded.' },
    { area: 'Top 10', mode: 'mock', source: 'local fallback', detail: 'Fallback candidates only.' },
    { area: 'Candles', mode: 'fallback', source: 'no-real-candles', detail: 'Candles are loaded from provider OHLCV only.' },
    { area: 'Backtest', mode: 'mock', source: 'mock-local', detail: 'Fallback strategy statistics.' },
    { area: 'Paper', mode: 'real', source: 'local-server-state', detail: 'Paper only, no broker execution.' },
  ],
  universeSize: 0,
  receivedSymbols: [],
  backtestSource: 'mock-local',
  updatedAt: '',
}

const marketPulse = ref<QuantLabMarketPulseItem[]>(DEFAULT_MARKET_PULSE)
const topPicks = ref<TopPick[]>(DEFAULT_TOP_PICKS)
const riskRules = ref<string[]>(DEFAULT_RISK_RULES)
const decision = ref<QuantLabDecision>(DEFAULT_DECISION)
const chartCaption = ref<string[]>(DEFAULT_CHART_CAPTION)
const graphCaption = ref<string[]>(DEFAULT_GRAPH_CAPTION)
const backtests = ref<QuantLabBacktest[]>(DEFAULT_BACKTESTS)
const backtestSummary = ref<string[]>(DEFAULT_BACKTEST_SUMMARY)
const dataHealth = ref<QuantLabDataHealth>(DEFAULT_DATA_HEALTH)
const wfRollingPerformance = ref<QuantLabWfRollingPerformance | null>(null)
const phaseValidationReport = ref<QuantLabPhaseValidationReport | null>(null)
const phaseValidationError = ref('')
const snapshotSource = ref('local fallback')
const snapshotGeneratedAt = ref('')
const snapshotError = ref('')
const paperGuardrails = ref<QuantLabPaperGuardrails | null>(null)
const latestMiroFishSeed = ref<QuantLabMiroFishSeed | null>(null)
const latestMiroFishInference = ref<QuantLabMiroFishInference | null>(null)
const mirofishTaskStatus = ref<QuantLabMiroFishGraphTaskStatus | null>(null)
const mirofishGraphSummary = ref<QuantLabMiroFishGraphSummary | null>(null)
const evidenceArchives = ref<QuantLabEvidenceArchiveEntry[]>([])
const loadingMiroFishTask = ref(false)
const loadingMiroFishGraph = ref(false)
const providerSettings = ref<QuantLabProviderSettings | null>(null)
const providerSettingsStatus = ref('')
const savingProviderSettings = ref(false)
const providerTest = ref<QuantLabProviderTestResult | null>(null)
const testingProviderFeeds = ref(false)
const candleBars = ref<QuantLabCandleBar[]>([])
const candleTimeframe = ref<QuantLabCandleTimeframe>('15m')
const candleTruth = ref<QuantLabDataTruthItem | null>(null)
const candleSource = ref('no-real-candles')
const candleStatus = ref('')
const loadingCandles = ref(false)
const quantSocket = useQuantSocket(buildQuantSocketUrl(), { fps: 12, reconnectMs: 3000 })
const quantSocketStatus = computed(() => quantSocket.status.value)
const quantSocketMessageCount = computed(() => quantSocket.messageCount.value)
const quantSocketFlushCount = computed(() => quantSocket.flushCount.value)
const { activeTicker, setActiveTicker, setTickerMetricsBatch } = useTerminalState()
const auroraAppWindowStore = useAuroraAppWindowStore()
let mirofishTaskTimer: number | undefined

function clearMiroFishTaskTimer(): void {
  if (!mirofishTaskTimer) return
  window.clearInterval(mirofishTaskTimer)
  mirofishTaskTimer = undefined
}

function syncMiroFishTaskPolling(): void {
  clearMiroFishTaskTimer()
  const status = mirofishTaskStatus.value?.task?.status || mirofishTaskStatus.value?.project?.status
  const terminal = status === 'completed' || status === 'failed' || status === 'graph_completed'
  if (!latestMiroFishInference.value?.graphTaskId || terminal) return
  mirofishTaskTimer = window.setInterval(() => {
    void refreshMiroFishTaskStatus()
  }, 3000)
}

async function refreshMiroFishGraphSummary(graphId?: string): Promise<void> {
  const resolvedGraphId = graphId || mirofishTaskStatus.value?.graphId
  if (!resolvedGraphId && !latestMiroFishInference.value?.graphTaskId && !latestMiroFishInference.value?.projectId) {
    mirofishGraphSummary.value = null
    return
  }

  loadingMiroFishGraph.value = true
  try {
    mirofishGraphSummary.value = await getQuantLabMiroFishGraphSummary({
      graphId: resolvedGraphId,
    })
  } catch (err: any) {
    mirofishGraphSummary.value = {
      ok: false,
      backendUrl: latestMiroFishInference.value?.backendUrl || '',
      checkedAt: new Date().toISOString(),
      graphId: resolvedGraphId,
      source: 'none',
      nodeCount: 0,
      edgeCount: 0,
      nodeTypes: [],
      edgeTypes: [],
      trackedNodes: [],
      topNodes: [],
      sampleEdges: [],
      error: err?.message || 'MiroFish graph summary failed',
    }
  } finally {
    loadingMiroFishGraph.value = false
  }
}

async function refreshMiroFishTaskStatus(): Promise<void> {
  const inference = latestMiroFishInference.value
  if (!inference?.graphTaskId && !inference?.projectId) {
    mirofishTaskStatus.value = null
    mirofishGraphSummary.value = null
    clearMiroFishTaskTimer()
    return
  }

  loadingMiroFishTask.value = true
  try {
    mirofishTaskStatus.value = await getQuantLabMiroFishTaskStatus({
      taskId: inference.graphTaskId,
      projectId: inference.projectId,
    })
  } catch (err: any) {
    mirofishTaskStatus.value = {
      ok: false,
      backendUrl: inference.backendUrl || '',
      checkedAt: new Date().toISOString(),
      projectId: inference.projectId,
      graphTaskId: inference.graphTaskId,
      error: err?.message || 'MiroFish task status failed',
    }
  } finally {
    loadingMiroFishTask.value = false
    const status = mirofishTaskStatus.value?.task?.status || mirofishTaskStatus.value?.project?.status
    if (mirofishTaskStatus.value?.graphId && (status === 'completed' || status === 'graph_completed')) {
      void refreshMiroFishGraphSummary(mirofishTaskStatus.value.graphId)
    }
    syncMiroFishTaskPolling()
  }
}

async function loadSnapshot(): Promise<void> {
  snapshotError.value = ''
  loadingSnapshot.value = true
  try {
    const snapshot = await getQuantLabSnapshot()
    marketPulse.value = snapshot.marketPulse
    topPicks.value = snapshot.topPicks
    riskRules.value = snapshot.riskRules
    decision.value = snapshot.decision
    chartCaption.value = snapshot.chartCaption
    graphCaption.value = snapshot.graphCaption
    backtests.value = snapshot.backtests
    backtestSummary.value = snapshot.backtestSummary
    dataHealth.value = snapshot.dataHealth || DEFAULT_DATA_HEALTH
    wfRollingPerformance.value = snapshot.wfRollingPerformance || null
    latestMiroFishSeed.value = snapshot.mirofishSeed || latestMiroFishSeed.value
    latestMiroFishInference.value = snapshot.mirofishInference || latestMiroFishInference.value
    snapshotSource.value = snapshot.source
    snapshotGeneratedAt.value = new Date(snapshot.generatedAt).toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    void refreshMiroFishTaskStatus()
  } catch (err: any) {
    snapshotError.value = err?.message || 'Snapshot failed'
    snapshotSource.value = 'local fallback'
  } finally {
    loadingSnapshot.value = false
  }
}

async function loadProviderSettings(): Promise<void> {
  try {
    providerSettings.value = await getQuantLabProviderSettings()
    providerSettingsStatus.value = providerSettings.value.envPath
  } catch (err: any) {
    providerSettingsStatus.value = err?.message || 'Provider settings unavailable'
  }
}

async function loadPhaseValidation(): Promise<void> {
  phaseValidationError.value = ''
  try {
    phaseValidationReport.value = await getQuantLabPhaseValidation({ ensure: false })
  } catch (err: any) {
    phaseValidationReport.value = null
    phaseValidationError.value = err?.message || 'Phase validation unavailable'
  }
}

async function loadPaperAccountFromServer(): Promise<void> {
  try {
    const remote = await getQuantLabPaperAccount()
    applyRemotePaperAccount(remote)
  } catch {
    // Keep the local paper account if the server-side state is not available yet.
  }
}

async function loadEvidenceArchives(): Promise<void> {
  try {
    const result = await getQuantLabEvidenceArchives(30)
    evidenceArchives.value = result.entries
  } catch {
    evidenceArchives.value = []
  }
}

function applyRemotePaperAccount(remote: Awaited<ReturnType<typeof getQuantLabPaperAccount>>): void {
  paperGuardrails.value = remote.guardrails || null
  account.value = normalizeAccount({
    initialCapital: remote.initialCapital,
    cash: remote.cash,
    realizedPnl: remote.realizedPnl,
    maxEquity: remote.maxEquity,
    tradeCount: remote.tradeCount,
    wins: remote.wins,
    losses: remote.losses,
    grossProfit: remote.grossProfit,
    grossLoss: remote.grossLoss,
    positions: remote.positions,
    journal: remote.journal.map(entry => ({
      id: `${entry.time}-${entry.ticker}-${entry.action}`,
      time: entry.time.slice(11, 16) || entry.time,
      ticker: entry.ticker,
      action: entry.action as TradeAction,
      note: entry.note,
    })),
    equity: remote.equity,
    returnPct: remote.returnPct,
    dailyReturnPct: remote.dailyReturnPct,
    maxDrawdownPct: remote.maxDrawdownPct,
    winRate: remote.winRate,
    profitFactor: remote.profitFactor,
    valuationSource: 'server',
    valuationUpdatedAt: remote.updatedAt,
  })
}

function nowLabel(): string {
  return new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function makeEntry(ticker: string, action: TradeAction, note: string): JournalEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: nowLabel(),
    ticker,
    action,
    note,
  }
}

function createFreshAccount(): PaperAccountState {
  return {
    initialCapital: INITIAL_CAPITAL,
    cash: INITIAL_CAPITAL,
    realizedPnl: 0,
    maxEquity: INITIAL_CAPITAL,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    positions: [],
    journal: [
      makeEntry('SYSTEM', 'RESET', 'Paper account reset to $1000. No real orders are placed.'),
    ],
  }
}

function normalizeAccount(value: Partial<PaperAccountState>): PaperAccountState {
  const demo = createFreshAccount()
  return {
    ...demo,
    ...value,
    positions: Array.isArray(value.positions) ? value.positions : demo.positions,
    journal: Array.isArray(value.journal) ? value.journal : demo.journal,
  }
}

function loadPaperAccount(): PaperAccountState {
  return createFreshAccount()
}

function savePaperAccount(_state: PaperAccountState): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_KEY)
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatScorePart(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(value % 1 === 0 ? 0 : 1)}`
}

function getTone(value: number): 'up' | 'down' | 'warn' | 'neutral' {
  if (value > 0.05) return 'up'
  if (value < -0.05) return 'down'
  return 'neutral'
}

function getPick(ticker: string): TopPick | undefined {
  return realtimeTopPicks.value.find(pick => pick.ticker === ticker)
}

function getPositionValue(position: PaperPosition): number {
  return position.shares * position.lastPrice
}

function getPositionCost(position: PaperPosition): number {
  return position.shares * position.avgCost
}

const account = ref<PaperAccountState>(loadPaperAccount())

const realtimeTopPicks = computed(() => topPicks.value.map((pick) => {
  const tick = quantSocket.marketData.value[pick.ticker]
  if (!tick || typeof tick.price !== 'number') return pick

  return {
    ...pick,
    price: tick.price,
    trend: typeof tick.changePercent === 'number' ? formatPercent(tick.changePercent) : pick.trend,
  }
}))

const candleSymbol = computed(() => activeTicker.value || realtimeTopPicks.value[0]?.ticker || 'NVDA')

let candleRequestId = 0

async function loadCandles(symbol = candleSymbol.value): Promise<void> {
  const requestId = ++candleRequestId
  loadingCandles.value = true

  try {
    const result = await getQuantLabCandles({ symbol, timeframe: candleTimeframe.value, limit: candleTimeframe.value === '1d' ? 120 : 80 })
    if (requestId !== candleRequestId) return

    candleBars.value = result.bars
    candleTruth.value = result.dataTruth
    candleSource.value = result.source
    candleStatus.value = result.message || `${result.source} ${result.bars.length} bars`
  } catch (err: any) {
    if (requestId !== candleRequestId) return

    candleBars.value = []
    candleTruth.value = {
      area: 'Candles',
      mode: 'fallback',
      source: 'no-real-candles',
      detail: err?.message || 'Candle request failed',
    }
    candleSource.value = 'no-real-candles'
    candleStatus.value = err?.message || 'Candle request failed'
  } finally {
    if (requestId === candleRequestId) loadingCandles.value = false
  }
}

const hasUsablePaperQuoteStream = computed(() => {
  const health = dataHealth.value
  return health.status !== 'FALLBACK' &&
    health.status !== 'ERROR' &&
    !snapshotSource.value.includes('mock') &&
    !health.quoteSource.includes('mock')
})

const realtimeAccount = computed<PaperAccountState>(() => ({
  ...withAccountValuation({
    ...account.value,
    positions: account.value.positions.map((position) => {
      const tick = quantSocket.marketData.value[position.ticker]
      return {
        ...position,
        lastPrice: hasUsablePaperQuoteStream.value && typeof tick?.price === 'number' ? tick.price : position.lastPrice,
      }
    }),
  }, hasUsablePaperQuoteStream.value ? 'stream' : 'server'),
}))

function withAccountValuation(state: PaperAccountState, source: PaperAccountState['valuationSource']): PaperAccountState {
  const calculatedPositionsValue = state.positions.reduce((sum, position) => sum + getPositionValue(position), 0)
  const calculatedEquity = state.cash + calculatedPositionsValue
  const calculatedReturnPct = state.initialCapital > 0
    ? ((calculatedEquity - state.initialCapital) / state.initialCapital) * 100
    : 0
  const highWater = Math.max(state.maxEquity, calculatedEquity, state.initialCapital)
  const calculatedMaxDrawdownPct = highWater > 0 ? ((calculatedEquity - highWater) / highWater) * 100 : 0
  const completed = state.wins + state.losses
  const calculatedWinRate = completed > 0 ? (state.wins / completed) * 100 : 0
  const calculatedProfitFactor = state.grossLoss > 0
    ? state.grossProfit / state.grossLoss
    : state.grossProfit > 0
      ? Number.POSITIVE_INFINITY
      : 0

  return {
    ...state,
    equity: source === 'server' && typeof state.equity === 'number' ? state.equity : Number(calculatedEquity.toFixed(2)),
    returnPct: source === 'server' && typeof state.returnPct === 'number' ? state.returnPct : Number(calculatedReturnPct.toFixed(2)),
    maxDrawdownPct: source === 'server' && typeof state.maxDrawdownPct === 'number' ? state.maxDrawdownPct : Number(calculatedMaxDrawdownPct.toFixed(2)),
    winRate: source === 'server' && typeof state.winRate === 'number' ? state.winRate : Number(calculatedWinRate.toFixed(2)),
    profitFactor: source === 'server' && (typeof state.profitFactor === 'number' || state.profitFactor === null) ? state.profitFactor : calculatedProfitFactor,
    valuationSource: source,
  }
}

function buildMarketContextSummary(): string {
  return marketPulse.value.map(item => `${item.label} ${item.value}`).join(' | ')
}

function syncTerminalMetrics(): void {
  const marketContext = buildMarketContextSummary()
  const metrics = realtimeTopPicks.value.map<TerminalTickerMetrics>((pick) => {
    const position = realtimeAccount.value.positions.find(item => item.ticker === pick.ticker)
    const positionValue = position ? getPositionValue(position) : 0
    const positionCost = position ? getPositionCost(position) : 0
    const positionPnlPct = position && positionCost > 0
      ? formatPercent(((positionValue - positionCost) / positionCost) * 100)
      : undefined

    return {
      ticker: pick.ticker,
      price: pick.price,
      score: pick.score,
      signal: pick.action,
      action: pick.action,
      risk: pick.risk,
      trend: pick.trend,
      reasoning: pick.reason,
      source: pick.scoreBreakdown?.source || snapshotSource.value,
      updatedAt: new Date().toISOString(),
      marketContext,
      paperPosition: position ? formatCurrency(positionValue) : 'No open paper position',
      paperPnl: positionPnlPct,
      paperStop: position?.stop,
      details: {
        scoreBreakdown: pick.scoreBreakdown,
        decision: decision.value,
      },
    }
  })

  setTickerMetricsBatch(metrics)
}

watch([realtimeTopPicks, realtimeAccount, decision, marketPulse], () => {
  syncTerminalMetrics()
}, { immediate: true, deep: true })

watch([candleSymbol, candleTimeframe], ([symbol]) => {
  void loadCandles(symbol)
})

const positionsValue = computed(() => realtimeAccount.value.positions.reduce((sum, position) => sum + getPositionValue(position), 0))
const equity = computed(() => typeof realtimeAccount.value.equity === 'number' ? realtimeAccount.value.equity : realtimeAccount.value.cash + positionsValue.value)
const cumulativeReturn = computed(() => typeof realtimeAccount.value.returnPct === 'number' ? realtimeAccount.value.returnPct : ((equity.value - realtimeAccount.value.initialCapital) / realtimeAccount.value.initialCapital) * 100)
const drawdown = computed(() => {
  if (typeof realtimeAccount.value.maxDrawdownPct === 'number') return realtimeAccount.value.maxDrawdownPct
  const highWater = Math.max(realtimeAccount.value.maxEquity, equity.value)
  if (highWater <= 0) return 0
  return ((equity.value - highWater) / highWater) * 100
})
const winRate = computed(() => {
  if (typeof realtimeAccount.value.winRate === 'number') return realtimeAccount.value.winRate
  const completed = realtimeAccount.value.wins + realtimeAccount.value.losses
  return completed > 0 ? (realtimeAccount.value.wins / completed) * 100 : 0
})
const profitFactor = computed(() => {
  if (typeof realtimeAccount.value.profitFactor === 'number') return realtimeAccount.value.profitFactor
  if (realtimeAccount.value.profitFactor === null && realtimeAccount.value.grossProfit > 0) return Number.POSITIVE_INFINITY
  if (realtimeAccount.value.grossLoss > 0) return realtimeAccount.value.grossProfit / realtimeAccount.value.grossLoss
  return realtimeAccount.value.grossProfit > 0 ? Number.POSITIVE_INFINITY : 0
})
const sharpeProxy = computed(() => {
  const riskBase = Math.max(Math.abs(drawdown.value), 1)
  return cumulativeReturn.value / riskBase
})

const kpis = computed(() => [
  { label: 'Equity', value: formatCurrency(equity.value), tone: getTone(cumulativeReturn.value) },
  { label: 'Cash', value: formatCurrency(realtimeAccount.value.cash), tone: 'neutral' },
  { label: 'Positions', value: formatCurrency(positionsValue.value), tone: 'neutral' },
  { label: 'P/L', value: formatPercent(cumulativeReturn.value), tone: getTone(cumulativeReturn.value) },
  { label: 'Max DD', value: formatPercent(drawdown.value), tone: drawdown.value < -5 ? 'down' : 'warn' },
  { label: 'Win Rate', value: `${winRate.value.toFixed(0)}%`, tone: winRate.value >= 50 ? 'up' : 'warn' },
  { label: 'Profit Factor', value: Number.isFinite(profitFactor.value) ? profitFactor.value.toFixed(2) : '∞', tone: profitFactor.value >= 1 ? 'up' : 'warn' },
  { label: 'Sharpe', value: sharpeProxy.value.toFixed(2), tone: sharpeProxy.value > 0 ? 'up' : 'neutral' },
])

const positions = computed(() => realtimeAccount.value.positions.map(position => {
  const value = getPositionValue(position)
  const pnl = value - getPositionCost(position)
  const pnlPct = getPositionCost(position) > 0 ? (pnl / getPositionCost(position)) * 100 : 0
  return {
    ticker: position.ticker,
    size: formatCurrency(value),
    pnl: formatPercent(pnlPct),
    stop: position.stop,
  }
}))

const journal = computed(() => account.value.journal.slice(0, 8))
const fullJournal = computed(() => account.value.journal.slice(0, 40))
const filteredFullJournal = computed(() => {
  const entries = fullJournal.value
  if (journalFilter.value === 'all') return entries
  if (journalFilter.value === 'trade') return entries.filter(entry => entry.action === 'BUY' || entry.action === 'SELL')
  if (journalFilter.value === 'watch') return entries.filter(entry => entry.action === 'WATCH' || entry.action === 'HOLD')
  if (journalFilter.value === 'guard') {
    return entries.filter(entry => {
      const text = `${entry.ticker} ${entry.note}`.toLowerCase()
      return text.includes('risk') || text.includes('guard') || text.includes('blocked') || text.includes('loss') || text.includes('風控')
    })
  }
  return entries.filter(entry => entry.ticker === 'SYSTEM' || entry.action === 'MARK' || entry.action === 'RESET')
})
const buyCandidates = computed(() => realtimeTopPicks.value.filter(pick => pick.action === 'BUY'))
const watchCandidates = computed(() => realtimeTopPicks.value.filter(pick => pick.action === 'WATCH'))
const topAverageScore = computed(() => {
  if (!realtimeTopPicks.value.length) return 0
  return realtimeTopPicks.value.reduce((sum, pick) => sum + pick.score, 0) / realtimeTopPicks.value.length
})
const highRiskCount = computed(() => realtimeTopPicks.value.filter(pick => pick.risk === 'H').length)
const exposureRows = computed(() => realtimeAccount.value.positions.map(position => {
  const pick = getPick(position.ticker)
  const value = getPositionValue(position)
  const weight = equity.value > 0 ? (value / equity.value) * 100 : 0
  const cost = getPositionCost(position)
  const pnlPct = cost > 0 ? ((value - cost) / cost) * 100 : 0
  const riskFlag = weight > 20 ? '超過單檔上限' : pick?.risk === 'H' ? '高風險' : '正常'

  return {
    ticker: position.ticker,
    value: formatCurrency(value),
    weight: `${weight.toFixed(1)}%`,
    pnl: formatPercent(pnlPct),
    stop: position.stop,
    risk: pick?.risk || 'M',
    riskFlag,
  }
}))
const riskChecklist = computed(() => {
  const guard = paperGuardrails.value
  const buysToday = guard ? Object.keys(guard.buysToday || {}).length : 0
  return [
    {
      label: '單檔上限',
      value: `${Math.max(0, ...exposureRows.value.map(row => Number.parseFloat(row.weight))).toFixed(1)}% / 20%`,
      detail: '',
      tone: exposureRows.value.some(row => Number.parseFloat(row.weight) > 20) ? 'down' : 'up',
    },
    {
      label: '持倉數',
      value: `${realtimeAccount.value.positions.length} / ${MAX_POSITIONS}`,
      detail: '',
      tone: realtimeAccount.value.positions.length > MAX_POSITIONS ? 'down' : 'up',
    },
    {
      label: '單日損益',
      value: `${(guard?.dailyReturnPct ?? 0).toFixed(2)}% / -2%`,
      detail: '',
      tone: (guard?.dailyReturnPct ?? 0) <= -2 ? 'down' : (guard?.dailyReturnPct ?? 0) < 0 ? 'warn' : 'up',
    },
    {
      label: '連續虧損',
      value: `${guard?.consecutiveLosses ?? 0} / 2`,
      detail: guard?.pauseNewBuysUntil ? `paused until ${guard.pauseNewBuysUntil}` : '',
      tone: (guard?.consecutiveLosses ?? 0) >= 2 ? 'down' : (guard?.consecutiveLosses ?? 0) === 1 ? 'warn' : 'up',
    },
    {
      label: '今日重複買入',
      value: `${buysToday} tickers`,
      detail: guard ? Object.keys(guard.buysToday || {}).join(', ') : '',
      tone: buysToday ? 'warn' : 'up',
    },
    {
      label: 'Guard',
      value: guard?.status || 'LOCAL',
      detail: guard?.reason || 'server guardrails not loaded yet',
      tone: guard?.status === 'BLOCKED' ? 'down' : 'up',
    },
    {
      label: '帳戶回撤',
      value: `${drawdown.value.toFixed(2)}% / -10%`,
      detail: '',
      tone: drawdown.value <= -10 ? 'down' : drawdown.value <= -5 ? 'warn' : 'up',
    },
    {
      label: '高風險候選',
      value: `${highRiskCount.value}`,
      detail: '',
      tone: highRiskCount.value >= 3 ? 'warn' : 'neutral',
    },
  ]
})

const guardSummary = computed(() => {
  if (!paperGuardrails.value) {
    return {
      status: 'LOCAL',
      tone: 'warn',
      reason: '等待 server guardrails',
    }
  }
  return {
    status: paperGuardrails.value.status,
    tone: paperGuardrails.value.status === 'BLOCKED' ? 'down' : 'up',
    reason: paperGuardrails.value.reason,
  }
})

const mirofishSeedSummary = computed(() => {
  if (!latestMiroFishSeed.value) {
    return {
      status: '待產生',
      tone: 'warn',
      path: '執行開盤前或收盤後簡報後會自動建立 seed',
      updatedAt: '',
    }
  }

  return {
    status: '已產生',
    tone: 'up',
    path: latestMiroFishSeed.value.relativePath || latestMiroFishSeed.value.path,
    updatedAt: latestMiroFishSeed.value.updatedAt
      ? new Date(latestMiroFishSeed.value.updatedAt).toLocaleString('zh-TW', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : '',
  }
})

const dataHealthItems = computed(() => [
  { label: 'Status', value: dataHealth.value.status || 'OK', tone: dataHealth.value.status === 'OK' ? 'up' : 'warn' },
  { label: 'Quotes', value: dataHealth.value.quoteCoverage || 'n/a', tone: dataHealth.value.missingSymbols.length ? 'warn' : 'up' },
  { label: 'Quote Source', value: dataHealth.value.quoteProvider || dataHealth.value.quoteSource || snapshotSource.value, tone: dataHealth.value.fallbackUsed ? 'warn' : 'neutral' },
  { label: 'Latency', value: typeof dataHealth.value.quoteLatencyMs === 'number' ? `${Math.round(dataHealth.value.quoteLatencyMs)}ms` : 'n/a', tone: 'neutral' },
  { label: 'Backtest', value: dataHealth.value.backtestSource || 'n/a', tone: dataHealth.value.backtestSource.includes('fallback') ? 'warn' : 'up' },
  { label: 'Missing', value: dataHealth.value.missingSymbols.length ? dataHealth.value.missingSymbols.join(', ') : 'none', tone: dataHealth.value.missingSymbols.length ? 'warn' : 'up' },
])

const phaseValidationSummary = computed(() => {
  const report = phaseValidationReport.value
  if (!report) return null
  const passed = report.phases.filter(phase => phase.status === 'PASS').length
  return {
    ok: report.ok,
    passed,
    total: report.phases.length,
    firstFailed: report.firstFailedPhase,
  }
})

const valuationPaperBuyGuardCheck = computed(() => {
  const paperPhase = phaseValidationReport.value?.phases.find(phase => phase.key === 'phase-6-paper')
  return paperPhase?.checks.find(check => check.key === 'valuation-paper-buy-guard') || null
})

const phaseValidationItems = computed<PhaseValidationDisplayItem[]>(() => {
  const summary = phaseValidationSummary.value
  const guardCheck = valuationPaperBuyGuardCheck.value
  return [
    {
      label: 'Phase Validation',
      value: summary ? `${summary.passed}/${summary.total}` : phaseValidationError.value ? 'ERROR' : 'loading',
      detail: summary?.ok ? 'all phases pass' : summary?.firstFailed ? `${summary.firstFailed.key} failed` : phaseValidationError.value,
      tone: summary?.ok ? 'up' : phaseValidationError.value ? 'down' : 'warn',
    },
    {
      label: 'Valuation Paper-Buy Guard',
      value: guardCheck?.status || (phaseValidationError.value ? 'ERROR' : 'pending'),
      detail: guardCheck?.detail || phaseValidationError.value || 'waiting for phase-6-paper check',
      tone: guardCheck?.status === 'PASS' ? 'up' : guardCheck?.status === 'FAIL' || phaseValidationError.value ? 'down' : 'warn',
    },
  ]
})

const currentTitle = computed(() => {
  if (activeView.value === 'mirofish') return 'MiroFish Scenario Graph'
  if (activeView.value === 'backtest') return 'Backtest Curve'
  return 'Price / Regime View'
})

function syncHighWaterMark(): void {
  if (equity.value > account.value.maxEquity) {
    account.value.maxEquity = equity.value
  }
}

function addJournal(ticker: string, action: TradeAction, note: string): void {
  account.value.journal.unshift(makeEntry(ticker, action, note))
  account.value.journal = account.value.journal.slice(0, 50)
}

async function buyPick(pick: TopPick): Promise<void> {
  paperActionPending.value = `BUY-${pick.ticker}`
  try {
    const remote = await updateQuantLabPaperAccount({ action: 'BUY', ticker: pick.ticker })
    applyRemotePaperAccount(remote)
    return
  } catch (err: any) {
    addJournal('SYSTEM', 'WATCH', `伺服器紙上買入失敗；第四階段風控已停用本機備援。${err?.message || ''}`.trim())
    return
  } finally {
    paperActionPending.value = ''
  }
}

async function sellTicker(ticker: string): Promise<void> {
  paperActionPending.value = `SELL-${ticker}`
  try {
    const remote = await updateQuantLabPaperAccount({ action: 'SELL', ticker })
    applyRemotePaperAccount(remote)
    return
  } catch (err: any) {
    addJournal('SYSTEM', 'WATCH', `伺服器紙上賣出失敗；已使用本機備援。${err?.message || ''}`.trim())
  } finally {
    paperActionPending.value = ''
  }

  const index = account.value.positions.findIndex(position => position.ticker === ticker)
  if (index < 0) {
    addJournal(ticker, 'WATCH', '沒有可賣出的紙上持倉。')
    return
  }

  const position = account.value.positions[index]
  const value = getPositionValue(position)
  const pnl = value - getPositionCost(position)
  account.value.positions.splice(index, 1)
  account.value.cash += value
  account.value.realizedPnl += pnl
  account.value.tradeCount += 1

  if (pnl >= 0) {
    account.value.wins += 1
    account.value.grossProfit += pnl
  } else {
    account.value.losses += 1
    account.value.grossLoss += Math.abs(pnl)
  }

  syncHighWaterMark()
  addJournal(ticker, 'SELL', `${formatCurrency(value)} 紙上賣出。已實現損益：${formatCurrency(pnl)}。`)
}

async function markToMarket(): Promise<void> {
  paperActionPending.value = 'MARK'
  try {
    const remote = await updateQuantLabPaperAccount({ action: 'MARK' })
    applyRemotePaperAccount(remote)
    return
  } catch (err: any) {
    addJournal('SYSTEM', 'WATCH', `伺服器標記失敗；第四階段風控已停用本機備援標記。${err?.message || ''}`.trim())
    return
  } finally {
    paperActionPending.value = ''
  }
}

async function resetPaperAccount(): Promise<void> {
  paperActionPending.value = 'RESET'
  try {
    const remote = await updateQuantLabPaperAccount({ action: 'RESET' })
    applyRemotePaperAccount(remote)
    return
  } catch (err: any) {
    addJournal('SYSTEM', 'WATCH', `伺服器重設失敗；已使用本機備援。${err?.message || ''}`.trim())
  } finally {
    paperActionPending.value = ''
  }

  account.value = createFreshAccount()
}

async function addJournalFromTerminal(entry: { ticker?: string; action?: string; note: string }): Promise<void> {
  const ticker = (entry.ticker || 'AI').trim().toUpperCase()
  const action = ['BUY', 'SELL', 'HOLD', 'WATCH', 'RESET', 'MARK'].includes((entry.action || '').toUpperCase())
    ? (entry.action || 'WATCH').toUpperCase() as TradeAction
    : 'WATCH'
  const note = (entry.note || '').trim()
  if (!note) return

  paperActionPending.value = `JOURNAL-${ticker}`
  try {
    const remote = await updateQuantLabPaperAccount({
      action: 'JOURNAL',
      ticker,
      journalAction: action,
      note,
    })
    applyRemotePaperAccount(remote)
    return
  } catch (err: any) {
    addJournal('SYSTEM', 'WATCH', `伺服器日記寫入失敗；已使用本機備援。${err?.message || ''}`.trim())
  } finally {
    paperActionPending.value = ''
  }

  addJournal(ticker, action, note)
}

function escapeMarkdownCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ')
}

function decisionJournalRowsForReport(): string {
  return topPicks.value
    .slice(0, 6)
    .map(pick => {
      const why = `${pick.reason}; score ${pick.score}; trend ${pick.trend}; confidence ${pick.scoreBreakdown?.confidence || 'n/a'}`
      const next = pick.action === 'BUY'
        ? 'Verify support, volume, VIX, and 10Y before adding or holding.'
        : pick.action === 'WATCH'
          ? 'Verify breakout or pullback support before paper buy.'
          : 'Verify score improves before changing from hold.'
      return `| ${pick.ticker} | ${pick.action} | ${escapeMarkdownCell(why)} | ${pick.risk} / ${pick.scoreBreakdown?.source || 'n/a'} | ${next} |`
    })
    .join('\n')
}

function generateReportMarkdown(): string {
  const kpiRows = kpis.value
    .map(kpi => `| ${kpi.label} | ${kpi.value} |`)
    .join('\n')
  const pulseRows = marketPulse.value
    .map(item => `| ${item.label} | ${item.value} |`)
    .join('\n')
  const topRows = topPicks.value
    .map(pick => {
      const score = pick.scoreBreakdown
      return `| ${pick.ticker} | ${pick.score} | ${formatScorePart(score?.quality)} | ${formatScorePart(score?.momentum)} | ${formatScorePart(score?.regime)} | ${formatScorePart(score?.risk)} | ${score?.confidence || 'n/a'} | ${pick.action} | ${pick.risk} | ${formatCurrency(pick.price)} | ${pick.reason.replace(/\|/g, '/')} |`
    })
    .join('\n')
  const positionRows = account.value.positions.length
    ? account.value.positions
        .map(position => {
          const value = getPositionValue(position)
          const cost = getPositionCost(position)
          const pnl = value - cost
          const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0
          return `| ${position.ticker} | ${position.shares.toFixed(4)} | ${formatCurrency(position.avgCost)} | ${formatCurrency(position.lastPrice)} | ${formatCurrency(value)} | ${formatPercent(pnlPct)} | ${position.stop} |`
        })
        .join('\n')
    : '| - | - | - | - | - | - | No open paper positions |'
  const journalRows = account.value.journal
    .slice(0, 20)
    .map(entry => `| ${entry.time} | ${entry.ticker} | ${entry.action} | ${entry.note.replace(/\|/g, '/')} |`)
    .join('\n')

  return `---
title: Hermes Quant Lab ${todayKey()}
created: ${new Date().toISOString()}
type: trading-journal
status: draft
tags:
  - hermes
  - quant-lab
  - paper-trading
confidence: medium
owner: hermes
---

# Hermes Quant Lab ${todayKey()}

> Paper trading only. This report is for research, journaling, and review. It is not a real brokerage order log.
> Data source: ${snapshotSource.value}${snapshotGeneratedAt.value ? ` / ${snapshotGeneratedAt.value}` : ''}
> Data health: ${dataHealth.value.status || 'OK'}, quotes ${dataHealth.value.quoteCoverage}, quote source ${dataHealth.value.quoteSource}, latency ${dataHealth.value.quoteLatencyMs ?? 'n/a'}ms, backtest ${dataHealth.value.backtestSource}

## Market Pulse

| Indicator | Value |
|---|---:|
${pulseRows}

## Paper Account KPI

| KPI | Value |
|---|---:|
${kpiRows}

## Top 10 Candidates

| Ticker | Score | Quality | Momentum | Regime | Risk Adj | Confidence | Action | Risk | Mock Price | Reason |
|---|---:|---:|---:|---:|---:|---|---|---|---:|---|
${topRows}

## Positions

| Ticker | Shares | Avg Cost | Last Price | Value | P/L | Stop |
|---|---:|---:|---:|---:|---:|---|
${positionRows}

## Trading Journal

| Time | Ticker | Action | Note |
|---|---|---|---|
${journalRows}

## Decision Journal

| Ticker | Decision | Why / Why Not | Risk / Source | Next Validation |
|---|---|---|---|---|
${decisionJournalRowsForReport()}

## Guardrails

- Status：${paperGuardrails.value?.status || 'local fallback'}
- Reason：${paperGuardrails.value?.reason || 'server guardrails not loaded yet'}
- Daily P/L：${(paperGuardrails.value?.dailyReturnPct ?? 0).toFixed(2)}%
- Consecutive losses：${paperGuardrails.value?.consecutiveLosses ?? 0}
- Same-day buys：${paperGuardrails.value ? Object.keys(paperGuardrails.value.buysToday || {}).join(', ') || 'none' : 'n/a'}

## Hermes Review

- 今日結論：${decision.value.conclusion}
- 建議動作：${decision.value.action}
- 失效條件：${decision.value.invalidation}
- 下一次檢查：開盤前與收盤後重新標記持倉與 KPI。
`
}

function generateTelegramSummary(): string {
  const topFive = topPicks.value
    .slice(0, 5)
    .map((pick, index) => `${index + 1}. ${pick.ticker} ${pick.score} ${pick.action} ${pick.risk} - ${pick.reason}`)
    .join('\n')
  const positionLines = positions.value.length
    ? positions.value.map(position => `${position.ticker} ${position.size} P/L ${position.pnl}`).join('\n')
    : 'No open paper positions.'

  return `HERMES Quant Lab ${todayKey()}

Paper account only, no real orders.

Market: ${marketPulse.value.map(item => `${item.label} ${item.value}`).join(' | ')}
Data: ${dataHealth.value.status || 'OK'} ${dataHealth.value.quoteSource} quotes ${dataHealth.value.quoteCoverage} latency ${dataHealth.value.quoteLatencyMs ?? 'n/a'}ms | backtest ${dataHealth.value.backtestSource}

KPI:
Equity ${formatCurrency(equity.value)}
Cash ${formatCurrency(account.value.cash)}
P/L ${formatPercent(cumulativeReturn.value)}
Max DD ${formatPercent(drawdown.value)}
Win Rate ${winRate.value.toFixed(0)}%
Guard ${paperGuardrails.value?.status || 'local'}: ${paperGuardrails.value?.reason || 'server guardrails not loaded'}

Top 5:
${topFive}

Positions:
${positionLines}

Hermes:
${decision.value.conclusion}
Invalidation: ${decision.value.invalidation}`
}

async function saveReportToObsidian(): Promise<void> {
  savingReport.value = true
  saveStatus.value = ''
  try {
    const fileName = `${todayKey()}-quant-lab.md`
    const result = await saveQuantLabReport({
      fileName,
      content: generateReportMarkdown(),
    })
    const savedPath = result.relativePath || result.path
    saveStatus.value = `已存入 ${savedPath}`
    addJournal('ARCHIVE', 'MARK', `已將量化實驗室報告存到 ${savedPath}。`)
  } catch (err: any) {
    saveStatus.value = err?.message || '儲存失敗'
  } finally {
    savingReport.value = false
  }
}

async function pushTelegramSummary(): Promise<void> {
  sendingTelegram.value = true
  telegramStatus.value = ''
  try {
    const result = await sendQuantLabTelegram({ text: generateTelegramSummary() })
    telegramStatus.value = result.skipped ? `Telegram 已略過：${result.reason || '重複通知'}` : '已推送 Telegram'
    addJournal('TELEGRAM', 'MARK', result.skipped ? `已略過重複 Telegram 摘要：${result.reason || '重複'}。` : '已推送量化實驗室摘要到 Telegram。')
  } catch (err: any) {
    telegramStatus.value = err?.message || 'Telegram 推送失敗'
  } finally {
    sendingTelegram.value = false
  }
}

async function runDailyBrief(phase: QuantLabBriefPhase): Promise<void> {
  runningBrief.value = phase
  briefStatus.value = ''
  try {
    const result = await runQuantLabBrief({
      phase,
      saveReport: true,
      sendTelegram: true,
      forceTelegram: false,
    })
    await loadSnapshot()
    await loadPaperAccountFromServer()
    await loadEvidenceArchives()
    await loadCandles()

    const label = phase === 'premarket' ? '開盤前' : '收盤後'
    const savedPath = result.saved?.relativePath || result.saved?.path || '未存檔'
    const seedPath = result.mirofish?.seed?.relativePath || result.mirofish?.seed?.path || ''
    const evidencePath = result.mirofish?.evidenceArchive?.relativePath || result.mirofish?.evidenceArchive?.path || ''
    if (result.mirofish?.seed) latestMiroFishSeed.value = result.mirofish.seed
    if (result.mirofish?.inference) latestMiroFishInference.value = result.mirofish.inference
    await refreshMiroFishTaskStatus()
    const telegramText = result.telegram?.skipped
      ? `Telegram 已略過：${result.telegram.reason || '重複通知'}`
      : result.telegram?.ok
        ? 'Telegram 已推送'
        : `Telegram 未推送：${result.telegram?.error || '未知錯誤'}`
    const inferenceText = result.mirofish?.inference ? `推演 ${result.mirofish.inference.status}/${result.mirofish.inference.confidence}；` : ''
    briefStatus.value = `${label}簡報完成：${savedPath}；${seedPath ? `情境種子 ${seedPath}；` : ''}${evidencePath ? `證據 ${evidencePath}；` : ''}${inferenceText}${telegramText}`
    addJournal('BRIEF', 'MARK', `${label}簡報已存到 ${savedPath}。${seedPath ? `情境種子 ${seedPath}。` : ''}${evidencePath ? `證據 ${evidencePath}。` : ''}來源：${result.source}。`)
  } catch (err: any) {
    briefStatus.value = err?.message || '簡報執行失敗'
  } finally {
    runningBrief.value = null
  }
}

async function runWeeklySummary(): Promise<void> {
  runningWeeklySummary.value = true
  briefStatus.value = ''
  try {
    const result = await runQuantLabWeeklySummary({
      saveReport: true,
      sendTelegram: true,
      forceTelegram: false,
    })
    await loadSnapshot()
    await loadPaperAccountFromServer()
    await loadEvidenceArchives()
    await loadCandles()

    const savedPath = result.saved?.relativePath || result.saved?.path || '未存檔'
    const telegramText = result.telegram?.skipped
      ? `Telegram 已略過：${result.telegram.reason || '重複通知'}`
      : result.telegram?.ok
        ? 'Telegram 已推送'
        : `Telegram 未推送：${result.telegram?.error || '未知錯誤'}`
    briefStatus.value = `每週總結完成：${savedPath}；來源簡報 ${result.sourceBriefs.length} 份；${telegramText}`
    addJournal('WEEKLY', 'MARK', `每週總結已存到 ${savedPath}。來源簡報 ${result.sourceBriefs.length} 份；股票池 ${dataHealth.value.stockUniverseSize || dataHealth.value.universeSize || result.topPicks.length} 檔。`)
  } catch (err: any) {
    briefStatus.value = err?.message || '每週總結失敗'
  } finally {
    runningWeeklySummary.value = false
  }
}

async function runMiroFishScenario(): Promise<void> {
  runningMiroFish.value = true
  briefStatus.value = ''
  try {
    const result = await runQuantLabMiroFish({
      phase: 'premarket',
      submitBackend: true,
      targetTicker: activeTicker.value || realtimeTopPicks.value[0]?.ticker,
    })
    if (result.mirofish.seed) latestMiroFishSeed.value = result.mirofish.seed
    if (result.mirofish.inference) latestMiroFishInference.value = result.mirofish.inference
    await refreshMiroFishTaskStatus()
    await loadPaperAccountFromServer()
    await loadEvidenceArchives()
    const inference = result.mirofish.inference
    const reportPath = inference?.reportRelativePath || inference?.reportPath || '未產生報告'
    const evidencePath = result.mirofish.evidenceArchive?.relativePath || result.mirofish.evidenceArchive?.path || ''
    briefStatus.value = `情境推演完成：${inference?.status || result.mirofish.status} / ${inference?.confidence || 'n/a'}；${reportPath}${evidencePath ? `；證據 ${evidencePath}` : ''}`
    addJournal('SCENARIO', 'MARK', `第五階段推演 ${inference?.status || result.mirofish.status}；報告 ${reportPath}。${evidencePath ? `證據 ${evidencePath}。` : ''}`)
  } catch (err: any) {
    briefStatus.value = err?.message || '情境推演失敗'
  } finally {
    runningMiroFish.value = false
  }
}

function openMiroFishRiskBridge(pick: TopPick): void {
  setActiveTicker(pick.ticker)
  addJournal(pick.ticker, 'MARK', `Aurora Risk Bridge opened MiroFish Arena for ${pick.ticker}.`)
  auroraAppWindowStore.openApp('mirofish-arena', {
    launchContext: {
      source: 'quant-risk-bridge',
      targetTicker: pick.ticker,
      pick,
      snapshotSource: snapshotSource.value,
      snapshotGeneratedAt: snapshotGeneratedAt.value,
      decision: {
        action: decision.value.action,
        conclusion: decision.value.conclusion,
        invalidation: decision.value.invalidation,
      },
      marketPulse: marketPulse.value.slice(0, 6),
    },
  })
}

function openMiroFishRiskBridgeBatch(picks: TopPick[]): void {
  const batchPicks = picks
    .filter(pick => typeof pick.ticker === 'string' && pick.ticker.trim())
    .slice(0, 3)
  const firstPick = batchPicks[0]
  if (!firstPick) return

  setActiveTicker(firstPick.ticker)
  addJournal('BATCH', 'MARK', `Aurora Risk Bridge batch opened MiroFish Arena for ${batchPicks.map(pick => pick.ticker).join(', ')}.`)
  auroraAppWindowStore.openApp('mirofish-arena', {
    launchContext: {
      source: 'quant-risk-bridge-batch',
      targetTicker: firstPick.ticker,
      pick: firstPick,
      batchPicks,
      batchLimit: batchPicks.length,
      snapshotSource: snapshotSource.value,
      snapshotGeneratedAt: snapshotGeneratedAt.value,
      decision: {
        action: decision.value.action,
        conclusion: decision.value.conclusion,
        invalidation: decision.value.invalidation,
      },
      marketPulse: marketPulse.value.slice(0, 6),
    },
  })
}

async function refreshQuantLab(): Promise<void> {
  await loadProviderSettings()
  await loadSnapshot()
  await loadPaperAccountFromServer()
  await loadEvidenceArchives()
  await loadCandles()
}

async function saveProviderKeys(payload: SaveQuantLabProviderSettingsPayload): Promise<void> {
  savingProviderSettings.value = true
  providerSettingsStatus.value = ''
  try {
    providerSettings.value = await saveQuantLabProviderSettings(payload)
    providerSettingsStatus.value = `資料源設定已儲存；正在測試資料源...`
    await testProviderFeeds()
  } catch (err: any) {
    providerSettingsStatus.value = err?.message || '資料源設定儲存失敗'
  } finally {
    savingProviderSettings.value = false
  }
}

async function testProviderFeeds(): Promise<void> {
  testingProviderFeeds.value = true
  providerSettingsStatus.value = ''
  try {
    providerTest.value = await testQuantLabProviderFeeds({ symbol: candleSymbol.value, timeframe: candleTimeframe.value })
    providerSettingsStatus.value = `資料源測試 ${providerTest.value.status}：${providerTest.value.symbol} ${providerTest.value.timeframe}`
    await loadSnapshot()
    await loadPaperAccountFromServer()
    await loadEvidenceArchives()
    await loadCandles()
  } catch (err: any) {
    providerSettingsStatus.value = err?.message || '資料源測試失敗'
  } finally {
    testingProviderFeeds.value = false
  }
}

function setCandleTimeframe(timeframe: QuantLabCandleTimeframe): void {
  if (candleTimeframe.value === timeframe) return
  candleTimeframe.value = timeframe
}

watch(account, (state) => {
  savePaperAccount(state)
}, { deep: true })

watch(() => latestMiroFishInference.value?.graphTaskId, () => {
  void refreshMiroFishTaskStatus()
})

onMounted(async () => {
  await loadProviderSettings()
  await loadSnapshot()
  await loadPhaseValidation()
  await loadPaperAccountFromServer()
  await loadEvidenceArchives()
  await loadCandles()
})

onUnmounted(() => {
  clearMiroFishTaskTimer()
})
</script>

<template>
  <main class="quant-lab">
    <QuantTerminal
      :market-pulse="marketPulse"
      :top-picks="realtimeTopPicks"
      :decision="decision"
      :account="realtimeAccount"
      :journal="journal"
      :guardrails="paperGuardrails"
      :latest-seed="latestMiroFishSeed"
      :mirofish-inference="latestMiroFishInference"
      :mirofish-task-status="mirofishTaskStatus"
      :mirofish-graph-summary="mirofishGraphSummary"
      :evidence-archives="evidenceArchives"
      :loading-miro-fish-task="loadingMiroFishTask"
      :loading-miro-fish-graph="loadingMiroFishGraph"
      :data-health="dataHealth"
      :wf-rolling-performance="wfRollingPerformance"
      :phase-validation-items="phaseValidationItems"
      :backtests="backtests"
      :snapshot-source="snapshotSource"
      :snapshot-generated-at="snapshotGeneratedAt"
      :loading-snapshot="loadingSnapshot"
      :running-brief="runningBrief"
      :running-weekly-summary="runningWeeklySummary"
      :running-miro-fish="runningMiroFish"
      :paper-action-pending="paperActionPending"
      :saving-report="savingReport"
      :sending-telegram="sendingTelegram"
      :brief-status="briefStatus"
      :save-status="saveStatus"
      :telegram-status="telegramStatus"
      :socket-status="quantSocketStatus"
      :socket-message-count="quantSocketMessageCount"
      :socket-flush-count="quantSocketFlushCount"
      :candles="candleBars"
      :candle-truth="candleTruth"
      :candle-source="candleSource"
      :candle-status="candleStatus"
      :loading-candles="loadingCandles"
      :candle-timeframe="candleTimeframe"
      :provider-settings="providerSettings"
      :provider-settings-status="providerSettingsStatus"
      :saving-provider-settings="savingProviderSettings"
      :provider-test="providerTest"
      :testing-provider-feeds="testingProviderFeeds"
      @refresh="refreshQuantLab"
      @mark="markToMarket"
      @reset="resetPaperAccount"
      @save="saveReportToObsidian"
      @telegram="pushTelegramSummary"
      @paper-buy="buyPick"
      @paper-sell="sellTicker"
      @run-mirofish-for-pick="openMiroFishRiskBridge"
      @run-mirofish-batch="openMiroFishRiskBridgeBatch"
      @run-brief="runDailyBrief"
      @run-weekly-summary="runWeeklySummary"
      @run-mirofish="runMiroFishScenario"
      @refresh-mirofish-task="refreshMiroFishTaskStatus"
      @refresh-mirofish-graph="refreshMiroFishGraphSummary"
      @add-journal="addJournalFromTerminal"
      @save-provider-settings="saveProviderKeys"
      @test-provider-feeds="testProviderFeeds"
      @change-candle-timeframe="setCandleTimeframe"
    />
    <template v-if="false">
    <header class="ql-header">
      <div>
        <p class="eyebrow">Hermes Quant Lab V1</p>
        <h1>量化推演工作台</h1>
        <p class="data-source">
          Data: {{ snapshotSource }}
          <span v-if="snapshotGeneratedAt">/ {{ snapshotGeneratedAt }}</span>
          <span v-if="snapshotError">/ fallback</span>
        </p>
      </div>
      <div class="ql-tabs" aria-label="Quant Lab sections">
        <button
          v-for="section in sectionTabs"
          :key="section.key"
          class="tab"
          :class="{ active: activeSection === section.key }"
          @click="activeSection = section.key"
        >
          {{ section.label }}
        </button>
      </div>
    </header>

    <section class="pulse-strip" aria-label="Market pulse">
      <div
        v-for="item in marketPulse"
        :key="item.label"
        class="pulse-cell"
        :class="`tone-${item.tone}`"
      >
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </div>
    </section>

    <section v-if="activeSection === 'overview'" class="terminal-grid">
      <aside class="watchlist-pane">
        <div class="pane-title">
          <span>今日 Top 10</span>
          <strong>Score</strong>
        </div>
        <table class="terminal-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Score</th>
              <th>Action</th>
              <th>Risk</th>
              <th>Trade</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pick in topPicks" :key="pick.ticker">
              <td>
                <strong>{{ pick.ticker }}</strong>
                <small>{{ pick.reason }}</small>
              </td>
              <td>{{ pick.score }}</td>
              <td :class="`action-${pick.action.toLowerCase()}`">{{ pick.action }}</td>
              <td>{{ pick.risk }}</td>
              <td class="trade-actions">
                <button :disabled="!!paperActionPending" title="Paper buy" @click="buyPick(pick)">B</button>
                <button :disabled="!!paperActionPending" title="Paper sell" @click="sellTicker(pick.ticker)">S</button>
              </td>
            </tr>
          </tbody>
        </table>
      </aside>

      <section class="main-pane">
        <div class="pane-toolbar">
          <div>
            <span class="pane-kicker">Main View</span>
            <h2>{{ currentTitle }}</h2>
          </div>
          <div class="view-switch">
            <button :class="{ active: activeView === 'price' }" @click="activeView = 'price'">價格</button>
            <button :class="{ active: activeView === 'mirofish' }" @click="activeView = 'mirofish'">MiroFish</button>
            <button :class="{ active: activeView === 'backtest' }" @click="activeView = 'backtest'">回測</button>
          </div>
        </div>

        <div v-if="activeView === 'price'" class="chart-stage">
          <svg viewBox="0 0 860 390" role="img" aria-label="Prototype price chart">
            <defs>
              <linearGradient id="priceGlow" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="#16c784" stop-opacity="0.32" />
                <stop offset="100%" stop-color="#16c784" stop-opacity="0" />
              </linearGradient>
            </defs>
            <g class="grid-lines">
              <path d="M0 65H860M0 130H860M0 195H860M0 260H860M0 325H860" />
              <path d="M120 0V390M240 0V390M360 0V390M480 0V390M600 0V390M720 0V390" />
            </g>
            <path class="price-fill" d="M0 306 L58 280 L116 286 L174 248 L232 260 L290 210 L348 224 L406 182 L464 190 L522 132 L580 154 L638 108 L696 122 L754 88 L812 96 L860 70 L860 390 L0 390 Z" />
            <path class="price-line" d="M0 306 L58 280 L116 286 L174 248 L232 260 L290 210 L348 224 L406 182 L464 190 L522 132 L580 154 L638 108 L696 122 L754 88 L812 96 L860 70" />
            <g class="volume-bars">
              <rect x="30" y="340" width="18" height="32" />
              <rect x="92" y="330" width="18" height="42" />
              <rect x="154" y="348" width="18" height="24" />
              <rect x="216" y="315" width="18" height="57" />
              <rect x="278" y="322" width="18" height="50" />
              <rect x="340" y="298" width="18" height="74" />
              <rect x="402" y="315" width="18" height="57" />
              <rect x="464" y="286" width="18" height="86" />
              <rect x="526" y="306" width="18" height="66" />
              <rect x="588" y="278" width="18" height="94" />
              <rect x="650" y="292" width="18" height="80" />
              <rect x="712" y="262" width="18" height="110" />
              <rect x="774" y="282" width="18" height="90" />
            </g>
          </svg>
          <div class="chart-caption">
            <span v-for="caption in chartCaption" :key="caption">{{ caption }}</span>
          </div>
        </div>

        <div v-else-if="activeView === 'mirofish'" class="graph-stage">
          <MiroFishScenarioGraph
            :top-picks="topPicks"
            :market-pulse="marketPulse"
            :decision="decision"
            :guardrails="paperGuardrails"
            :latest-seed="latestMiroFishSeed"
            :journal="journal"
            :positions="account.positions"
          />
          <div class="chart-caption">
            <span v-for="caption in graphCaption" :key="caption">{{ caption }}</span>
          </div>
        </div>

        <div v-else class="backtest-stage">
          <table class="terminal-table wide">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>CAGR</th>
                <th>Sharpe</th>
                <th>Max DD</th>
                <th>Win</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in backtests" :key="row.strategy">
                <td>{{ row.strategy }}</td>
                <td class="positive">{{ row.cagr }}</td>
                <td>{{ row.sharpe }}</td>
                <td class="warning">{{ row.maxDd }}</td>
                <td>{{ row.win }}</td>
                <td>{{ row.status }}</td>
              </tr>
            </tbody>
          </table>
          <div class="backtest-summary">
            <span v-for="item in backtestSummary" :key="item">{{ item }}</span>
          </div>
        </div>
      </section>

      <aside class="decision-pane">
        <div class="pane-title">
          <span>Hermes 判讀</span>
          <strong>Paper mode</strong>
        </div>
        <div class="decision-block">
          <label>今日結論</label>
          <p>{{ decision.conclusion }}</p>
        </div>
        <div class="decision-block">
          <label>建議動作</label>
          <p>{{ decision.action }}</p>
        </div>
        <div class="decision-block">
          <label>失效條件</label>
          <p>{{ decision.invalidation }}</p>
        </div>
        <div class="decision-block">
          <label>交易紀律</label>
          <div class="status-line">
            <strong class="status-pill" :class="`tone-${guardSummary.tone}`">{{ guardSummary.status }}</strong>
            <p>{{ guardSummary.reason }}</p>
          </div>
        </div>
        <div class="decision-block seed-block">
          <label>Last MiroFish Seed</label>
          <div class="status-line">
            <strong class="status-pill" :class="`tone-${mirofishSeedSummary.tone}`">{{ mirofishSeedSummary.status }}</strong>
            <p>
              {{ mirofishSeedSummary.path }}
              <small v-if="mirofishSeedSummary.updatedAt">{{ mirofishSeedSummary.updatedAt }}</small>
            </p>
          </div>
        </div>
        <div class="action-panel">
          <div class="action-group">
            <span>Data</span>
            <button :disabled="loadingSnapshot" @click="loadSnapshot">
              {{ loadingSnapshot ? '更新中' : '刷新資料' }}
            </button>
            <button :disabled="!!paperActionPending" @click="markToMarket">重新計算</button>
          </div>
          <div class="action-group">
            <span>Brief</span>
            <button :disabled="!!runningBrief" @click="runDailyBrief('premarket')">
              {{ runningBrief === 'premarket' ? '產生中' : '開盤前簡報' }}
            </button>
            <button :disabled="!!runningBrief" @click="runDailyBrief('afterclose')">
              {{ runningBrief === 'afterclose' ? '產生中' : '收盤後簡報' }}
            </button>
          </div>
          <div class="action-group utility">
            <span>Output</span>
            <button :disabled="savingReport" @click="saveReportToObsidian">
              {{ savingReport ? '儲存中' : '存到 Obsidian' }}
            </button>
            <button :disabled="sendingTelegram" @click="pushTelegramSummary">
              {{ sendingTelegram ? '推送中' : '推送 Telegram' }}
            </button>
            <button :disabled="!!paperActionPending" @click="resetPaperAccount">重設帳戶</button>
          </div>
        </div>
        <p v-if="briefStatus" class="save-status">{{ briefStatus }}</p>
        <p v-if="saveStatus" class="save-status">{{ saveStatus }}</p>
        <p v-if="telegramStatus" class="save-status">{{ telegramStatus }}</p>
      </aside>
    </section>

    <section v-if="activeSection === 'overview'" class="bottom-grid">
      <div class="kpi-strip">
        <div v-for="kpi in kpis" :key="kpi.label" class="kpi-cell" :class="`tone-${kpi.tone}`">
          <span>{{ kpi.label }}</span>
          <strong>{{ kpi.value }}</strong>
        </div>
      </div>

      <div class="positions-pane">
        <div class="pane-title">
          <span>持倉 / 風控</span>
          <strong>$1000 paper account</strong>
        </div>
        <table class="terminal-table compact">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Size</th>
              <th>P/L</th>
              <th>Stop</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="position in positions" :key="position.ticker">
              <td>{{ position.ticker }}</td>
              <td>{{ position.size }}</td>
              <td :class="position.pnl.startsWith('+') ? 'positive' : 'negative'">{{ position.pnl }}</td>
              <td>{{ position.stop }}</td>
            </tr>
            <tr v-if="positions.length === 0">
              <td colspan="4" class="empty-cell">No open paper positions.</td>
            </tr>
          </tbody>
        </table>
        <ul class="rules-list">
          <li v-for="rule in riskRules" :key="rule">{{ rule }}</li>
        </ul>
      </div>

      <div class="journal-pane">
        <div class="pane-title">
          <span>交易日記</span>
          <strong>auto draft</strong>
        </div>
        <div class="journal-row" v-for="entry in journal" :key="`${entry.time}-${entry.ticker}`">
          <time>{{ entry.time }}</time>
          <strong>{{ entry.ticker }} {{ entry.action }}</strong>
          <p>{{ entry.note }}</p>
        </div>
      </div>
    </section>

    <section v-else-if="activeSection === 'top10'" class="section-panel">
      <div class="section-toolbar">
        <div>
          <span class="pane-kicker">Candidate Board</span>
          <h2>Top 10 候選清單</h2>
        </div>
        <div class="summary-line">
          <span>BUY {{ buyCandidates.length }}</span>
          <span>WATCH {{ watchCandidates.length }}</span>
          <span>AVG {{ topAverageScore.toFixed(1) }}</span>
          <span>{{ dataHealth.quoteSource }}</span>
        </div>
      </div>
      <div class="data-health-strip">
        <div v-for="item in dataHealthItems" :key="item.label" class="data-health-cell" :class="`tone-${item.tone}`">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
        </div>
      </div>
      <div class="phase-validation-strip" aria-label="Quant Lab phase validation">
        <div v-for="item in phaseValidationItems" :key="item.label" class="phase-validation-cell" :class="`tone-${item.tone}`">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.detail }}</small>
        </div>
      </div>
      <table class="terminal-table detail-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Ticker</th>
            <th>Score</th>
            <th>Action</th>
            <th>Trend</th>
            <th>Risk</th>
            <th>Price</th>
            <th>Reason</th>
            <th>Paper</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(pick, index) in topPicks" :key="pick.ticker">
            <td>{{ index + 1 }}</td>
            <td><strong>{{ pick.ticker }}</strong></td>
            <td class="score-detail">
              <strong>{{ pick.score }}</strong>
              <small>
                Q {{ formatScorePart(pick.scoreBreakdown?.quality) }}
                M {{ formatScorePart(pick.scoreBreakdown?.momentum) }}
                G {{ formatScorePart(pick.scoreBreakdown?.regime) }}
                R {{ formatScorePart(pick.scoreBreakdown?.risk) }}
              </small>
            </td>
            <td :class="`action-${pick.action.toLowerCase()}`">{{ pick.action }}</td>
            <td :class="pick.trend.startsWith('+') ? 'positive' : pick.trend.startsWith('-') ? 'negative' : ''">{{ pick.trend }}</td>
            <td>{{ pick.risk }}</td>
            <td>{{ formatCurrency(pick.price) }}</td>
            <td>
              {{ pick.reason }}
              <small>{{ pick.scoreBreakdown?.confidence || 'n/a' }} / {{ pick.scoreBreakdown?.source || 'n/a' }}</small>
            </td>
            <td class="trade-actions">
              <button :disabled="!!paperActionPending" title="Paper buy" @click="buyPick(pick)">B</button>
              <button :disabled="!!paperActionPending" title="Paper sell" @click="sellTicker(pick.ticker)">S</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-else-if="activeSection === 'journal'" class="section-panel split-panel">
      <div class="journal-pane expanded">
        <div class="pane-title">
          <span>交易日記</span>
          <strong>{{ filteredFullJournal.length }} / {{ fullJournal.length }} entries</strong>
        </div>
        <div class="filter-bar" aria-label="Journal filters">
          <button
            v-for="filter in journalFilterOptions"
            :key="filter.key"
            class="filter-button"
            :class="{ active: journalFilter === filter.key }"
            @click="journalFilter = filter.key"
          >
            {{ filter.label }}
          </button>
        </div>
        <div class="journal-row" v-for="entry in filteredFullJournal" :key="`${entry.time}-${entry.ticker}-${entry.note}`">
          <time>{{ entry.time }}</time>
          <strong>{{ entry.ticker }} {{ entry.action }}</strong>
          <p>{{ entry.note }}</p>
        </div>
        <div v-if="filteredFullJournal.length === 0" class="empty-journal">
          目前沒有符合這個篩選的交易日記。
        </div>
      </div>
      <div class="positions-pane expanded">
        <div class="pane-title">
          <span>Paper Account</span>
          <strong>{{ formatCurrency(equity) }}</strong>
        </div>
        <div class="kpi-strip vertical">
          <div v-for="kpi in kpis" :key="kpi.label" class="kpi-cell" :class="`tone-${kpi.tone}`">
            <span>{{ kpi.label }}</span>
            <strong>{{ kpi.value }}</strong>
          </div>
        </div>
        <div class="action-stack journal-actions">
          <button :disabled="savingReport" @click="saveReportToObsidian">
            {{ savingReport ? '儲存中' : '存到 Obsidian' }}
          </button>
          <button :disabled="sendingTelegram" @click="pushTelegramSummary">
            {{ sendingTelegram ? '推送中' : '推送 Telegram' }}
          </button>
          <button :disabled="!!paperActionPending" @click="markToMarket">重新計算</button>
          <button :disabled="!!paperActionPending" @click="resetPaperAccount">重設帳戶</button>
        </div>
        <p v-if="briefStatus" class="save-status">{{ briefStatus }}</p>
        <p v-if="saveStatus" class="save-status">{{ saveStatus }}</p>
        <p v-if="telegramStatus" class="save-status">{{ telegramStatus }}</p>
      </div>
    </section>

    <section v-else-if="activeSection === 'backtest'" class="section-panel">
      <div class="section-toolbar">
        <div>
          <span class="pane-kicker">Strategy Lab</span>
          <h2>歷史回測</h2>
        </div>
        <div class="summary-line">
          <span v-for="item in backtestSummary" :key="item">{{ item }}</span>
        </div>
      </div>
      <div class="backtest-stage standalone">
        <table class="terminal-table wide">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>CAGR</th>
              <th>Sharpe</th>
              <th>Max DD</th>
              <th>Win</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in backtests" :key="row.strategy">
              <td>{{ row.strategy }}</td>
              <td class="positive">{{ row.cagr }}</td>
              <td>{{ row.sharpe }}</td>
              <td class="warning">{{ row.maxDd }}</td>
              <td>{{ row.win }}</td>
              <td>{{ row.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-else class="section-panel">
      <div class="section-toolbar">
        <div>
          <span class="pane-kicker">Risk Console</span>
          <h2>風控檢查</h2>
        </div>
        <div class="summary-line">
          <span>{{ decision.invalidation }}</span>
        </div>
      </div>
      <div class="risk-check-strip">
        <div v-for="item in riskChecklist" :key="item.label" class="risk-check" :class="`tone-${item.tone}`">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small v-if="item.detail">{{ item.detail }}</small>
        </div>
      </div>
      <table class="terminal-table detail-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Value</th>
            <th>Weight</th>
            <th>P/L</th>
            <th>Risk</th>
            <th>Stop</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in exposureRows" :key="row.ticker">
            <td><strong>{{ row.ticker }}</strong></td>
            <td>{{ row.value }}</td>
            <td>{{ row.weight }}</td>
            <td :class="row.pnl.startsWith('+') ? 'positive' : 'negative'">{{ row.pnl }}</td>
            <td>{{ row.risk }}</td>
            <td>{{ row.stop }}</td>
            <td :class="row.riskFlag === '正常' ? 'positive' : 'warning'">{{ row.riskFlag }}</td>
          </tr>
          <tr v-if="exposureRows.length === 0">
            <td colspan="7" class="empty-cell">No open paper positions.</td>
          </tr>
        </tbody>
      </table>
      <ul class="rules-list expanded-rules">
        <li v-for="rule in riskRules" :key="rule">{{ rule }}</li>
      </ul>
    </section>
    </template>
  </main>
</template>

<style scoped lang="scss">
.quant-lab {
  min-height: 100vh;
  padding: 0;
  background: #050505;
  color: #e8edf2;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.ql-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid #1c252f;

  h1 {
    margin: 0;
    font-size: 22px;
    line-height: 1.2;
    font-weight: 780;
    letter-spacing: 0;
  }
}

.eyebrow {
  margin: 0 0 5px;
  color: #8a99a8;
  font-size: 11px;
  line-height: 1.2;
  text-transform: uppercase;
  letter-spacing: 0;
}

.data-source {
  margin: 6px 0 0;
  color: #6f7d8c;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  line-height: 1.35;
}

.ql-tabs,
.view-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tab,
.view-switch button,
.action-stack button {
  min-height: 28px;
  border: 1px solid #273241;
  background: #10151c;
  color: #aeb9c6;
  font-size: 12px;
  line-height: 1.2;
  border-radius: 4px;
  padding: 6px 10px;
}

.tab.active,
.view-switch button.active {
  border-color: #15b978;
  color: #eafff6;
  background: #0f251d;
}

.tab:not(:disabled),
.view-switch button:not(:disabled),
.action-stack button:not(:disabled),
.trade-actions button:not(:disabled) {
  cursor: pointer;
}

.pulse-strip,
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border: 1px solid #1c252f;
  border-top: 0;
  background: #0b1016;
}

.pulse-cell,
.kpi-cell {
  min-width: 0;
  padding: 10px 12px;
  border-right: 1px solid #1c252f;

  &:last-child {
    border-right: 0;
  }

  span {
    display: block;
    color: #7f8b98;
    font-size: 10px;
    line-height: 1.2;
    text-transform: uppercase;
  }

  strong {
    display: block;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #dce5ef;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 13px;
    line-height: 1.2;
    white-space: nowrap;
  }
}

.terminal-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.95fr) minmax(420px, 2.1fr) minmax(260px, 0.95fr);
  min-height: 520px;
  border-right: 1px solid #1c252f;
  border-left: 1px solid #1c252f;
}

.watchlist-pane,
.main-pane,
.decision-pane,
.positions-pane,
.journal-pane {
  min-width: 0;
  border-right: 1px solid #1c252f;
  background: #0b1016;
}

.decision-pane,
.journal-pane {
  border-right: 0;
}

.pane-title,
.pane-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 46px;
  padding: 10px 12px;
  border-bottom: 1px solid #1c252f;

  span,
  .pane-kicker {
    color: #8b98a6;
    font-size: 11px;
    text-transform: uppercase;
  }

  strong {
    color: #dce5ef;
    font-size: 11px;
    font-family: "SFMono-Regular", Consolas, monospace;
  }

  h2 {
    margin: 3px 0 0;
    font-size: 16px;
    line-height: 1.2;
    letter-spacing: 0;
  }
}

.terminal-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;

  th,
  td {
    padding: 8px 10px;
    border-bottom: 1px solid #17202a;
    text-align: left;
    vertical-align: middle;
  }

  th {
    color: #778492;
    font-size: 10px;
    font-weight: 650;
    text-transform: uppercase;
  }

  td {
    color: #d9e1ea;
    font-family: "SFMono-Regular", Consolas, monospace;
  }

  small {
    display: block;
    margin-top: 3px;
    overflow: hidden;
    color: #6f7b88;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 10px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &.wide th,
  &.wide td {
    padding: 12px;
  }
}

.trade-actions {
  display: flex;
  gap: 4px;

  button {
    width: 24px;
    height: 22px;
    border: 1px solid #273241;
    border-radius: 4px;
    background: #0e151d;
    color: #aeb9c6;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 11px;
    line-height: 1;

    &:first-child {
      border-color: #135f43;
      color: #16c784;
    }

    &:last-child {
      border-color: #6a262b;
      color: #ef4444;
    }
  }
}

.main-pane {
  display: flex;
  flex-direction: column;
}

.chart-stage,
.graph-stage,
.backtest-stage {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: 14px;
}

.chart-stage svg,
.graph-stage svg {
  flex: 1;
  width: 100%;
  min-height: 320px;
  border: 1px solid #17202a;
  background: #070a0e;
}

.grid-lines path {
  fill: none;
  stroke: #18222d;
  stroke-width: 1;
}

.price-fill {
  fill: url(#priceGlow);
}

.price-line {
  fill: none;
  stroke: #16c784;
  stroke-width: 3;
}

.volume-bars rect {
  fill: #2b8bd6;
  opacity: 0.42;
}

.chart-caption,
.backtest-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 10px;
  color: #8593a2;
  font-size: 11px;
}

.graph-link path {
  fill: none;
  stroke: #405165;
  stroke-width: 1.5;
}

.node {
  stroke: #dfe8f2;
  stroke-width: 1.5;
}

.node-green {
  fill: #16c784;
}

.node-blue {
  fill: #2b8bd6;
}

.node-purple {
  fill: #8b5cf6;
}

.node-red {
  fill: #ef4444;
}

.node-yellow {
  fill: #f4b740;
}

.graph-stage text {
  fill: #f8fbff;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  font-weight: 700;
  text-anchor: middle;
}

.decision-block {
  padding: 14px 12px;
  border-bottom: 1px solid #17202a;

  label {
    display: block;
    margin-bottom: 7px;
    color: #7f8b98;
    font-size: 11px;
  }

  p {
    margin: 0;
    color: #dce5ef;
    font-size: 13px;
    line-height: 1.55;
  }
}

.status-line {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 9px;
  align-items: start;

  p {
    min-width: 0;
    word-break: break-word;
  }

  small {
    display: block;
    margin-top: 4px;
    color: #7b8794;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 10px;
    line-height: 1.3;
  }
}

.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 58px;
  min-height: 22px;
  border: 1px solid #273241;
  border-radius: 999px;
  background: #0e151d;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  line-height: 1;
}

.seed-block p {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
}

.action-panel {
  display: grid;
  gap: 10px;
  padding: 12px;
}

.action-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;

  span {
    grid-column: 1 / -1;
    color: #7f8b98;
    font-size: 10px;
    line-height: 1.2;
    text-transform: uppercase;
  }

  button {
    min-height: 28px;
    border: 1px solid #273241;
    border-radius: 4px;
    background: #10151c;
    color: #aeb9c6;
    font-size: 12px;
    line-height: 1.2;
    padding: 6px 10px;

    &:not(:disabled) {
      cursor: pointer;
    }

    &:disabled {
      cursor: not-allowed;
      color: #5f6b78;
      background: #0e131a;
    }
  }

  &.utility {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.action-stack {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 12px;

  button:disabled {
    cursor: not-allowed;
    color: #5f6b78;
    background: #0e131a;
  }
}

.save-status {
  margin: 0;
  padding: 0 12px 12px;
  color: #8f9cab;
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
}

.empty-cell {
  color: #6f7b88 !important;
  text-align: center !important;
}

.bottom-grid {
  display: grid;
  grid-template-columns: minmax(360px, 1.1fr) minmax(420px, 1.4fr);
  border: 1px solid #1c252f;
}

.section-panel {
  min-height: 560px;
  overflow-x: auto;
  border-right: 1px solid #1c252f;
  border-bottom: 1px solid #1c252f;
  border-left: 1px solid #1c252f;
  background: #0b1016;
}

.section-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 58px;
  padding: 12px 14px;
  border-bottom: 1px solid #1c252f;

  h2 {
    margin: 3px 0 0;
    font-size: 17px;
    line-height: 1.2;
  }
}

.pane-kicker {
  color: #8b98a6;
  font-size: 11px;
  text-transform: uppercase;
}

.summary-line {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px 16px;
  max-width: 70%;
  color: #8f9cab;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
}

.detail-table {
  min-width: 900px;

  td,
  th {
    padding: 10px 12px;
  }
}

.score-detail strong {
  display: block;
  color: #e8edf2;
}

.score-detail small {
  max-width: 180px;
  white-space: normal;
}

.data-health-strip {
  display: grid;
  grid-template-columns: 0.7fr 1fr 1fr 1.6fr;
  border-bottom: 1px solid #1c252f;
}

.phase-validation-strip {
  display: grid;
  grid-template-columns: minmax(220px, 0.7fr) minmax(360px, 1.3fr);
  border-bottom: 1px solid #1c252f;
  background: #0d141c;
}

.data-health-cell,
.phase-validation-cell {
  min-width: 0;
  padding: 9px 12px;
  border-right: 1px solid #1c252f;

  &:last-child {
    border-right: 0;
  }

  span {
    display: block;
    color: #7f8b98;
    font-size: 10px;
    line-height: 1.2;
    text-transform: uppercase;
  }

  strong {
    display: block;
    margin-top: 4px;
    overflow: hidden;
    color: #dce5ef;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 12px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    display: block;
    margin-top: 4px;
    overflow: hidden;
    color: #7f8b98;
    font-size: 10px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.split-panel {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 0.8fr);
}

.expanded {
  min-height: 560px;
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid #17202a;
}

.filter-button {
  min-height: 26px;
  border: 1px solid #273241;
  border-radius: 4px;
  background: #10151c;
  color: #9aa6b3;
  font-size: 11px;
  line-height: 1;
  padding: 6px 10px;

  &.active {
    border-color: #15b978;
    color: #eafff6;
    background: #0f251d;
  }

  &:not(:disabled) {
    cursor: pointer;
  }
}

.kpi-strip.vertical {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-bottom: 1px solid #1c252f;

  .kpi-cell:nth-child(2n) {
    border-right: 0;
  }
}

.journal-actions {
  grid-template-columns: 1fr 1fr;
}

.backtest-stage.standalone {
  min-height: auto;
}

.risk-check-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid #1c252f;
}

.risk-check {
  min-width: 0;
  padding: 12px 14px;
  border-right: 1px solid #1c252f;

  &:last-child {
    border-right: 0;
  }

  span {
    display: block;
    color: #7f8b98;
    font-size: 10px;
    line-height: 1.2;
    text-transform: uppercase;
  }

  strong {
    display: block;
    margin-top: 5px;
    overflow: hidden;
    color: #dce5ef;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 13px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    display: block;
    margin-top: 5px;
    overflow: hidden;
    color: #7d8a98;
    font-size: 10px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.expanded-rules {
  border-top: 1px solid #17202a;
}

.kpi-strip {
  grid-column: 1 / -1;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  border: 0;
  border-bottom: 1px solid #1c252f;
}

.positions-pane {
  border-right: 1px solid #1c252f;
}

.compact td,
.compact th {
  padding: 8px 12px;
}

.rules-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 14px;
  margin: 0;
  padding: 12px;
  color: #8794a2;
  font-size: 11px;
  list-style-position: inside;
}

.journal-row {
  display: grid;
  grid-template-columns: 48px 108px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 11px 12px;
  border-bottom: 1px solid #17202a;

  time,
  strong {
    color: #dce5ef;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 12px;
    line-height: 1.4;
  }

  p {
    margin: 0;
    color: #8f9cab;
    font-size: 12px;
    line-height: 1.45;
  }
}

.empty-journal {
  padding: 18px 12px;
  color: #7f8b98;
  font-size: 12px;
  line-height: 1.45;
}

.tone-up strong,
.status-pill.tone-up,
.positive,
.action-buy {
  color: #16c784 !important;
}

.tone-down strong,
.status-pill.tone-down,
.negative {
  color: #ef4444 !important;
}

.tone-warn strong,
.status-pill.tone-warn,
.warning,
.action-watch {
  color: #f4b740 !important;
}

.tone-neutral strong,
.status-pill.tone-neutral,
.action-hold {
  color: #dce5ef !important;
}

@media (max-width: 1180px) {
  .terminal-grid {
    grid-template-columns: 1fr;
  }

  .watchlist-pane,
  .main-pane,
  .decision-pane {
    border-right: 0;
    border-bottom: 1px solid #1c252f;
  }

  .pulse-strip,
  .kpi-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .bottom-grid {
    grid-template-columns: 1fr;
  }

  .split-panel {
    grid-template-columns: 1fr;
  }

  .summary-line {
    justify-content: flex-start;
    max-width: none;
  }

  .risk-check-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .data-health-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .positions-pane {
    border-right: 0;
    border-bottom: 1px solid #1c252f;
  }
}

@media (max-width: 720px) {
  .quant-lab {
    padding: 10px;
  }

  .ql-header,
  .pane-toolbar,
  .section-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .journal-row {
    grid-template-columns: 1fr;
  }

  .rules-list {
    grid-template-columns: 1fr;
  }

  .risk-check-strip,
  .kpi-strip.vertical,
  .data-health-strip {
    grid-template-columns: 1fr;
  }

  .action-group,
  .action-group.utility {
    grid-template-columns: 1fr;
  }

  .risk-check,
  .kpi-strip.vertical .kpi-cell,
  .data-health-cell {
    border-right: 0;
    border-bottom: 1px solid #1c252f;
  }
}
</style>
