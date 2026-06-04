<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import FastMoneyText from './FastMoneyText.vue'
import MemoryVaultPanel from './MemoryVaultPanel.vue'
import MiroFishScenarioGraph from './MiroFishScenarioGraph.vue'
import PnLDashboard from './PnLDashboard.vue'
import TerminalCandlestickChart from './TerminalCandlestickChart.vue'
import TerminalEquityChart from './TerminalEquityChart.vue'
import type {
  QuantLabBacktest,
  QuantLabCandleBar,
  QuantLabCandleTimeframe,
  QuantLabDataHealth,
  QuantLabDataTruthItem,
  QuantLabDecision,
  QuantLabEvidenceArchiveEntry,
  QuantLabMarketPulseItem,
  QuantLabMiroFishGraphSummary,
  QuantLabMiroFishGraphTaskStatus,
  QuantLabMiroFishInference,
  QuantLabMiroFishSeed,
  QuantLabPaperGuardrails,
  QuantLabProviderSettings,
  QuantLabProviderTestResult,
  QuantLabTopPick,
  QuantLabWfRollingPerformance,
  SaveQuantLabProviderSettingsPayload,
} from '@/api/hermes/quant-lab'
import { useTerminalState } from '@/composables/useTerminalState'
import { useTerminalActions } from '@/composables/useTerminalActions'

interface TerminalPosition {
  ticker: string
  shares: number
  avgCost: number
  lastPrice: number
  stop: string
}

interface TerminalJournalEntry {
  id?: string
  time: string
  ticker: string
  action: string
  note: string
}

interface TerminalAccount {
  initialCapital: number
  cash: number
  realizedPnl: number
  maxEquity: number
  tradeCount: number
  wins: number
  losses: number
  grossProfit: number
  grossLoss: number
  positions: TerminalPosition[]
  journal: TerminalJournalEntry[]
  equity?: number
  returnPct?: number
  dailyReturnPct?: number
  maxDrawdownPct?: number
  winRate?: number
  profitFactor?: number | null
  valuationSource?: 'server' | 'stream' | 'local'
  valuationUpdatedAt?: string
}

type TerminalSection = 'overview' | 'top10' | 'journal' | 'pnl' | 'backtest' | 'data' | 'evidence' | 'memory' | 'risk'
type TerminalJournalAction = 'BUY' | 'SELL' | 'HOLD' | 'WATCH' | 'MARK' | 'RESET'
type TopPanelMode = 'compact' | 'normal' | 'expanded' | 'collapsed'

interface TerminalActionJournalPayload {
  ticker?: string
  action?: string
  note: string
}

interface TerminalAlert {
  id: string
  time: string
  ticker: string
  condition: string
  price: number | null
  note: string
}

interface PhaseValidationDisplayItem {
  label: string
  value: string
  detail: string
  tone: 'up' | 'down' | 'warn' | 'neutral'
}

const props = defineProps<{
  marketPulse: QuantLabMarketPulseItem[]
  topPicks: QuantLabTopPick[]
  decision: QuantLabDecision
  account: TerminalAccount
  journal: TerminalJournalEntry[]
  guardrails: QuantLabPaperGuardrails | null
  latestSeed: QuantLabMiroFishSeed | null
  mirofishInference: QuantLabMiroFishInference | null
  mirofishTaskStatus: QuantLabMiroFishGraphTaskStatus | null
  mirofishGraphSummary: QuantLabMiroFishGraphSummary | null
  evidenceArchives: QuantLabEvidenceArchiveEntry[]
  dataHealth: QuantLabDataHealth
  wfRollingPerformance: QuantLabWfRollingPerformance | null
  aiBottleneckRollingPerformance: QuantLabWfRollingPerformance | null
  youziCycleRollingPerformance: QuantLabWfRollingPerformance | null
  phaseValidationItems: PhaseValidationDisplayItem[]
  backtests: QuantLabBacktest[]
  snapshotSource: string
  snapshotGeneratedAt: string
  loadingSnapshot: boolean
  runningBrief: string | null
  runningWeeklySummary: boolean
  runningMiroFish: boolean
  loadingMiroFishTask: boolean
  loadingMiroFishGraph: boolean
  paperActionPending: string
  savingReport: boolean
  sendingTelegram: boolean
  briefStatus: string
  saveStatus: string
  telegramStatus: string
  socketStatus?: string
  socketMessageCount?: number
  socketFlushCount?: number
  candles: QuantLabCandleBar[]
  candleTruth: QuantLabDataTruthItem | null
  candleSource: string
  candleStatus: string
  loadingCandles: boolean
  candleTimeframe: QuantLabCandleTimeframe
  providerSettings: QuantLabProviderSettings | null
  providerSettingsStatus: string
  savingProviderSettings: boolean
  providerTest: QuantLabProviderTestResult | null
  testingProviderFeeds: boolean
}>()

const emit = defineEmits<{
  refresh: []
  mark: []
  reset: []
  save: []
  telegram: []
  paperBuy: [pick: QuantLabTopPick]
  paperSell: [ticker: string]
  runMirofishForPick: [pick: QuantLabTopPick]
  runMirofishBatch: [picks: QuantLabTopPick[]]
  runBrief: [phase: 'premarket' | 'afterclose']
  runWeeklySummary: []
  runMirofish: []
  refreshMirofishTask: []
  refreshMirofishGraph: []
  addJournal: [entry: TerminalActionJournalPayload]
  saveProviderSettings: [payload: SaveQuantLabProviderSettingsPayload]
  testProviderFeeds: []
  changeCandleTimeframe: [timeframe: QuantLabCandleTimeframe]
}>()

const activeSection = ref<TerminalSection>('overview')
const actionAlerts = ref<TerminalAlert[]>([])
const topPanelMode = ref<TopPanelMode>('normal')
const topHeight = ref(230)
const bottomHeight = ref(185)
const isDragging = ref(false)
const shellRef = ref<HTMLElement | null>(null)
const providerKeyForm = ref({
  alpacaKeyId: '',
  alpacaSecretKey: '',
  polygonApiKey: '',
})
const HEADER_HEIGHT = 30
const SPLITTER_HEIGHT = 4
const MIN_TOP_HEIGHT = 100
const MAX_TOP_HEIGHT = 520
const MIN_MIDDLE_HEIGHT = 180
const MIN_BOTTOM_HEIGHT = 120
const MAX_BOTTOM_HEIGHT = 430
type ResizeTarget = 'top' | 'bottom'
let resizeTarget: ResizeTarget | null = null
let resizeStartY = 0
let resizeStartTop = 230
let resizeStartBottom = 185
const candleTimeframeOptions: QuantLabCandleTimeframe[] = ['15m', '1h', '1d']
const { activeTicker, focusMode, setActiveTicker, clearFocus } = useTerminalState()
const { latestAction, actionAuditLog } = useTerminalActions()
const sectionTabs: Array<{ key: TerminalSection; label: string }> = [
  { key: 'overview', label: '總覽' },
  { key: 'top10', label: '前十' },
  { key: 'journal', label: '日記' },
  { key: 'pnl', label: '績效' },
  { key: 'backtest', label: '回測' },
  { key: 'data', label: '資料源' },
  { key: 'evidence', label: '證據' },
  { key: 'memory', label: '記憶庫' },
  { key: 'risk', label: '風控' },
]
const topPanelModes: Array<{ key: TopPanelMode; label: string; title: string }> = [
  { key: 'compact', label: '縮', title: '縮小上方資訊區' },
  { key: 'normal', label: '標', title: '標準上方資訊區' },
  { key: 'expanded', label: '展', title: '展開上方資訊區' },
  { key: 'collapsed', label: '隱', title: '隱藏上方資訊區，保留摘要列' },
]

function positionValue(position: TerminalPosition): number {
  return position.shares * position.lastPrice
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function formatCompactCurrency(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(2)}`
}

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatRatioPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  const pct = value * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

function formatSignedNumber(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}`
}

type RollingMetricKey = '1D' | '5D' | '10D' | '20D'

function rollingMetrics(source: QuantLabWfRollingPerformance | null, keys: RollingMetricKey[] = ['5D', '10D', '20D']) {
  if (!source) return []
  const metricMap: Record<RollingMetricKey, { label: string; avg: number | null | undefined; win: number | null | undefined; alpha: number | null | undefined; outperform: number | null | undefined; samples: number | undefined }> = {
    '1D': { label: '1D', avg: source.avgReturn1d, win: source.winRate1d, alpha: source.avgAlphaVsSpy1d, outperform: source.outperformSpyRate1d, samples: source.sampleCount1d },
    '5D': { label: '5D', avg: source.avgReturn5d, win: source.winRate5d, alpha: source.avgAlphaVsSpy5d, outperform: source.outperformSpyRate5d, samples: source.sampleCount5d },
    '10D': { label: '10D', avg: source.avgReturn10d, win: source.winRate10d, alpha: source.avgAlphaVsSpy10d, outperform: source.outperformSpyRate10d, samples: source.sampleCount10d },
    '20D': { label: '20D', avg: source.avgReturn20d, win: source.winRate20d, alpha: source.avgAlphaVsSpy20d, outperform: source.outperformSpyRate20d, samples: source.sampleCount20d },
  }
  return keys.map(key => {
    const metric = metricMap[key]
    return {
      label: metric.label,
      avg: formatRatioPercent(metric.avg),
      win: formatRatioPercent(metric.win),
      alpha: formatRatioPercent(metric.alpha),
      outperform: formatRatioPercent(metric.outperform),
      samples: metric.samples ?? 0,
    }
  })
}

const wfRollingMetrics = computed(() => rollingMetrics(props.wfRollingPerformance))
const aiBottleneckRollingMetrics = computed(() => rollingMetrics(props.aiBottleneckRollingPerformance, ['1D', '5D', '10D']))
const youziCycleRollingMetrics = computed(() => rollingMetrics(props.youziCycleRollingPerformance, ['1D', '5D', '10D']))

const wfRollingChangeText = computed(() => {
  const wf = props.wfRollingPerformance
  if (!wf) return '尚無 WF rolling dashboard 資料'
  const added = wf.latestAdded.length ? `新增 ${wf.latestAdded.join('/')}` : '新增 none'
  const removed = wf.latestRemoved.length ? `移除 ${wf.latestRemoved.join('/')}` : '移除 none'
  const kept = wf.latestKept.length ? `保留 ${wf.latestKept.join('/')}` : '保留 none'
  return `${added}｜${removed}｜${kept}`
})

const aiBottleneckRollingChangeText = computed(() => {
  const rolling = props.aiBottleneckRollingPerformance
  if (!rolling) return '尚無 AI Bottleneck rolling dashboard 資料'
  const added = rolling.latestAdded.length ? `新增 ${rolling.latestAdded.join('/')}` : '新增 none'
  const removed = rolling.latestRemoved.length ? `移除 ${rolling.latestRemoved.join('/')}` : '移除 none'
  const kept = rolling.latestKept.length ? `保留 ${rolling.latestKept.join('/')}` : '保留 none'
  return `${added}｜${removed}｜${kept}`
})

const youziCycleRollingChangeText = computed(() => {
  const rolling = props.youziCycleRollingPerformance
  if (!rolling) return '尚無 Youzi Cycle rolling dashboard 資料'
  const added = rolling.latestAdded.length ? `新增 ${rolling.latestAdded.join('/')}` : '新增 none'
  const removed = rolling.latestRemoved.length ? `移除 ${rolling.latestRemoved.join('/')}` : '移除 none'
  const kept = rolling.latestKept.length ? `保留 ${rolling.latestKept.join('/')}` : '保留 none'
  return `${added}｜${removed}｜${kept}`
})

const wfRollingSharpeText = computed(() => formatSignedNumber(props.wfRollingPerformance?.dailySharpeProxy, 2))

const actionLabels: Record<string, string> = {
  BUY: '買入',
  SELL: '賣出',
  HOLD: '持有',
  WATCH: '觀察',
  MARK: '標記',
  RESET: '重設',
}

const riskLabels: Record<string, string> = {
  L: '低',
  M: '中',
  H: '高',
}

const statusLabels: Record<string, string> = {
  OK: '正常',
  LOCAL: '本機',
  BLOCKED: '已阻擋',
  DEGRADED: '降級',
  FALLBACK: '備援',
  ERROR: '錯誤',
  PASS: '通過',
  WARN: '警告',
  BLOCK: '阻擋',
  ready: '就緒',
  ok: '正常',
  failed: '失敗',
  partial: '部分可用',
  skipped: '略過',
  'missing-key': '缺少金鑰',
  submitted: '已提交',
  report_ready: '報告完成',
  backend_available: '後端可用',
  backend_unavailable: '後端未連線',
  completed: '完成',
  graph_completed: '圖譜完成',
  failed_task: '任務失敗',
  not_run: '未執行',
  running: '執行中',
  pending: '等待中',
  Active: '啟用',
  Watch: '觀察',
  Hedge: '避險',
  Benchmark: '基準',
  'Risk-on': '風險偏好',
  'Risk-off': '避險',
}

const truthModeLabels: Record<string, string> = {
  real: '真實',
  partial: '部分真實',
  fallback: '備援',
  mock: '模擬',
}

const areaLabels: Record<string, string> = {
  Quotes: '報價',
  'Top 10': '前十候選',
  Candles: 'K 線',
  Backtest: '回測',
  Paper: '紙上帳戶',
}

const confidenceLabels: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 4) return '已遮蔽'
  return `••••${value.slice(-4)}`
}

function redactSensitiveText(value?: string): string {
  return String(value || '')
    .replace(/(apiKey=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:ALPACA|APCA|POLYGON|TELEGRAM)[A-Z0-9_]*(?:KEY|SECRET|TOKEN|CHAT_ID|USERS|IDS)\s*=\s*)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:ALPACA|APCA|POLYGON|TELEGRAM)[A-Z0-9_]*(?:KEY|SECRET|TOKEN|CHAT_ID|USERS|IDS)["']?\s*[:=]\s*["']?)[^"',\s<>]+/gi, '$1[redacted]')
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s"'<>]+/gi, 'https://api.telegram.org/bot[redacted]')
    .replace(/\bPK[A-Z0-9]{12,}\b/g, match => maskSecret(match))
}

function displayAction(value?: string): string {
  const normalized = String(value || '').trim().toUpperCase()
  return actionLabels[normalized] || value || '—'
}

function displayRisk(value?: string): string {
  const normalized = String(value || '').trim().toUpperCase()
  return riskLabels[normalized] || value || '—'
}

function displayStatus(value?: string): string {
  const normalized = String(value || '').trim()
  return statusLabels[normalized] || statusLabels[normalized.toUpperCase()] || value || '—'
}

function displayTruthMode(value?: string): string {
  const normalized = String(value || '').trim().toLowerCase()
  return truthModeLabels[normalized] || value || '—'
}

function displayArea(value?: string): string {
  return areaLabels[String(value || '')] || value || '—'
}

function displayConfidence(value?: string): string {
  const normalized = String(value || '').trim().toLowerCase()
  return confidenceLabels[normalized] || value || '—'
}

function displayValuationRiskTier(value?: string): string {
  const normalized = String(value || '').trim().toLowerCase()
  const labels: Record<string, string> = {
    'margin-of-safety': '安全邊際',
    reasonable: '估值合理',
    expensive: '偏貴',
    overheated: '過熱',
    unknown: '資料不足',
  }
  return labels[normalized] || value || '—'
}

function valuationRiskTone(value?: string): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'margin-of-safety' || normalized === 'reasonable') return 'positive'
  if (normalized === 'expensive' || normalized === 'unknown') return 'warning'
  if (normalized === 'overheated') return 'negative'
  return 'neutral'
}

function valuationAllowsPaperBuy(pick: QuantLabTopPick): boolean {
  const maxAction = String(pick.scoreBreakdown?.valuation?.maxAction || '').trim().toUpperCase()
  return !maxAction || maxAction === 'BUY'
}

function paperBuyDisabled(pick: QuantLabTopPick): boolean {
  return !!props.paperActionPending || !valuationAllowsPaperBuy(pick)
}

function paperBuyBlockReason(pick: QuantLabTopPick): string {
  if (props.paperActionPending) return '紙上交易執行中'
  const valuation = pick.scoreBreakdown?.valuation
  if (!valuation || valuationAllowsPaperBuy(pick)) return '紙上買入'
  const maxAction = displayAction(valuation.maxAction)
  return `估值風控阻擋買入：最高允許 ${maxAction}。${valuation.warning || ''}`.trim()
}

function displayPulseLabel(value: string): string {
  if (value === 'Regime') return '市場狀態'
  if (value === 'Oil') return '原油'
  return value
}

function displayPulseValue(label: string, value: string): string {
  if (label === 'Regime') {
    return value
      .replace(/Risk-on/gi, '風險偏好')
      .replace(/Risk-off/gi, '避險')
      .replace(/Mixed/gi, '混合')
  }
  return value
}

function displayPhase(value?: string): string {
  if (value === 'premarket') return '開盤前'
  if (value === 'afterclose') return '收盤後'
  return value || '—'
}

function displayRiskStatus(value: string): string {
  if (value === 'OVER LIMIT') return '超過上限'
  if (value === 'HIGH RISK') return '高風險'
  return displayStatus(value)
}

function displayRiskCheckLabel(value: string): string {
  const labels: Record<string, string> = {
    Guard: '風控',
    Daily: '單日損益',
    Drawdown: '回撤',
    Positions: '持倉數',
    'Repeat Buys': '重複買入',
    'High Risk': '高風險候選',
    Status: '狀態',
    Quotes: '報價',
    'Quote Source': '報價來源',
    Latency: '延遲',
    Backtest: '回測',
    'Paper Price': '紙上價格',
    Missing: '缺漏',
  }
  return labels[value] || value
}

function displayDiagnostic(value?: string): string {
  return displayJournalNote(value || '')
    .replace(/Configured\./gi, '已設定。')
    .replace(/Returned (\d+)/gi, '已回傳 $1')
    .replace(/request failed: HTTP/gi, '請求失敗：HTTP')
    .replace(/missing API keys?/gi, '缺少 API 金鑰')
    .replace(/Missing /gi, '缺少 ')
    .replace(/No rows returned/gi, '未回傳資料列')
    .replace(/No daily bars returned/gi, '未回傳日線資料')
    .replace(/No real OHLCV provider is configured for this timeframe/gi, '此週期尚未設定可用的真實 OHLCV 資料源')
    .replace(/Daily-only fallback skipped for intraday chart/gi, '日線備援已略過；盤中圖需要真實資料源')
    .replace(/Anonymous fallback provider; may rate-limit/gi, '匿名備援來源，可能被限流')
    .replace(/Delayed public fallback provider/gi, '延遲公開備援來源')
    .replace(/Snapshot quotes can still be plan-limited/gi, 'Snapshot 報價可能受方案限制')
}

function displayReason(value?: string): string {
  return displayJournalNote(value || '')
    .replace(/AI demand/gi, 'AI 需求')
    .replace(/20MA support/gi, '20MA 支撐')
    .replace(/quality compounder/gi, '高品質複利股')
    .replace(/semis flow/gi, '半導體資金流')
    .replace(/earnings strength/gi, '財報強勢')
    .replace(/ad cycle recovery/gi, '廣告週期修復')
    .replace(/margin expansion/gi, '利潤率擴張')
    .replace(/defensive growth/gi, '防禦型成長')
    .replace(/GLP-1 leadership/gi, 'GLP-1 領先')
    .replace(/breakout pending/gi, '等待突破')
    .replace(/rate sensitivity/gi, '利率敏感')
    .replace(/cloud acceleration/gi, '雲端加速')
    .replace(/accelerator leadership/gi, '加速器領先')
    .replace(/datacenter capex/gi, '資料中心資本支出')
    .replace(/cash flow/gi, '現金流')
    .replace(/AI platform/gi, 'AI 平台')
    .replace(/AI networking/gi, 'AI 網通')
    .replace(/AI optionality/gi, 'AI 選擇權')
    .replace(/buyback support/gi, '回購支撐')
    .replace(/membership renewal/gi, '會員續約')
    .replace(/pricing power/gi, '定價能力')
    .replace(/high beta/gi, '高 Beta')
    .replace(/policy overhang/gi, '政策壓力')
    .replace(/earnings (\d+)\/10/gi, '財報代理 $1/10')
    .replace(/above 20MA/gi, '高於 20MA')
    .replace(/below 20MA/gi, '低於 20MA')
    .replace(/broad universe/gi, '擴展股票池')
    .replace(/user configured universe/gi, '使用者自訂股票池')
    .replace(/needs trend and earnings validation/gi, '需要趨勢與財報驗證')
}

const exposure = computed(() => props.account.positions.reduce((sum, position) => sum + positionValue(position), 0))
const equity = computed(() => typeof props.account.equity === 'number' ? props.account.equity : props.account.cash + exposure.value)
const returnPct = computed(() => typeof props.account.returnPct === 'number'
  ? props.account.returnPct
  : props.account.initialCapital > 0
    ? ((equity.value - props.account.initialCapital) / props.account.initialCapital) * 100
    : 0)
const maxDrawdown = computed(() => {
  if (typeof props.account.maxDrawdownPct === 'number') return props.account.maxDrawdownPct
  const highWater = Math.max(props.account.maxEquity, equity.value, props.account.initialCapital)
  return highWater > 0 ? ((equity.value - highWater) / highWater) * 100 : 0
})
const winRate = computed(() => {
  if (typeof props.account.winRate === 'number') return props.account.winRate
  const closed = props.account.wins + props.account.losses
  return closed > 0 ? (props.account.wins / closed) * 100 : 0
})
const profitFactor = computed(() => {
  if (typeof props.account.profitFactor === 'number') return props.account.profitFactor
  if (props.account.profitFactor === null && props.account.grossProfit > 0) return Number.POSITIVE_INFINITY
  if (props.account.grossLoss > 0) return props.account.grossProfit / props.account.grossLoss
  return props.account.grossProfit > 0 ? Number.POSITIVE_INFINITY : 0
})
const accountSourceLabel = computed(() => props.account.valuationSource === 'stream' ? '串流估值' : '伺服器估值')
const topSignal = computed(() => {
  if (activeTicker.value) {
    const focused = props.topPicks.find(pick => pick.ticker === activeTicker.value)
    if (focused) return focused
  }
  return props.topPicks[0]
})
const buyCandidates = computed(() => props.topPicks.filter(pick => pick.action === 'BUY'))
const riskBridgeBatchPicks = computed(() => props.topPicks.slice(0, Math.min(3, props.topPicks.length)))
const tradeMode = computed(() => {
  if (props.guardrails?.status === 'BLOCKED') return '風控暫停'
  if (buyCandidates.value.length) return '偏多模式'
  return '觀察模式'
})
const tradeModeClass = computed(() => props.guardrails?.status === 'BLOCKED' ? 'negative' : buyCandidates.value.length ? 'positive' : 'warning')
const visibleTopHeight = computed(() => topPanelMode.value === 'collapsed' ? 34 : topHeight.value)
const topPanelStyle = computed(() => ({ height: `${visibleTopHeight.value}px` }))
const bottomPanelStyle = computed(() => ({ height: `${bottomHeight.value}px` }))
const topPanelModeLabel = computed(() => topPanelModes.find(mode => mode.key === topPanelMode.value)?.title || '標準上方資訊區')
const tickerTapeItems = computed(() => [
  ...props.marketPulse.map(item => ({ label: displayPulseLabel(item.label), value: displayPulseValue(item.label, item.value), tone: item.tone })),
  ...props.topPicks.slice(0, 12).map(pick => ({ label: pick.ticker, value: `${displayAction(pick.action)} ${pick.score} ${pick.trend}`, tone: pick.action === 'BUY' ? 'up' : pick.action === 'WATCH' ? 'warn' : 'neutral' })),
])
const tapeLoop = computed(() => [...tickerTapeItems.value, ...tickerTapeItems.value])

const equitySeries = computed(() => {
  const start = props.account.initialCapital
  const end = equity.value
  return Array.from({ length: 32 }, (_, index) => {
    const t = index / 31
    const noise = Math.sin(index * 0.65) * 6 + Math.cos(index * 0.2) * 4
    return start + (end - start) * t + noise
  })
})
const recentTrades = computed(() => props.journal.slice(0, 8))
const liveAnalytics = computed(() => [
  { label: '蒙地卡羅', value: props.guardrails?.status === 'BLOCKED' ? 42 : 78, tone: props.guardrails?.status === 'BLOCKED' ? 'negative' : 'positive' },
  { label: '訊號品質', value: Math.min(96, Math.max(25, topSignal.value?.score || 50)), tone: 'positive' },
  { label: '風險熱度', value: props.topPicks.filter(pick => pick.risk === 'H').length * 18 + (props.guardrails?.status === 'BLOCKED' ? 35 : 12), tone: props.guardrails?.status === 'BLOCKED' ? 'negative' : 'warning' },
  { label: '情境推演', value: props.mirofishInference ? (props.mirofishInference.confidence === 'high' ? 95 : props.mirofishInference.confidence === 'medium' ? 72 : 42) : props.latestSeed ? 55 : 25, tone: mirofishStatusTone.value },
])

const middleTitle = computed(() => {
  if (activeSection.value === 'top10') return '前十候選清單'
  if (activeSection.value === 'journal') return '決策日記'
  if (activeSection.value === 'pnl') return '紙上績效'
  if (activeSection.value === 'backtest') return '策略回測'
  if (activeSection.value === 'data') return '市場資料源'
  if (activeSection.value === 'evidence') return '證據封存'
  if (activeSection.value === 'memory') return '記憶庫'
  if (activeSection.value === 'risk') return '風控檢查'
  return '情境網路'
})

const middleMeta = computed(() => {
  if (activeSection.value === 'top10') return `${buyCandidates.value.length} 個買入候選 / 平均 ${averageScore.value.toFixed(1)} / 股票池 ${props.dataHealth.stockUniverseSize || props.dataHealth.universeSize || props.topPicks.length} 檔`
  if (activeSection.value === 'journal') return `${journalRows.value.length} 筆 / 紙上模式`
  if (activeSection.value === 'pnl') return 'NAV / 勝率 / 獲利因子 / 最大回撤'
  if (activeSection.value === 'backtest') return `${props.backtests.length} 個策略 / ${props.dataHealth.backtestSource}`
  if (activeSection.value === 'data') return `${dataTruthRows.value.length} 筆真實性 / ${providerStatusRows.value.length} 個來源`
  if (activeSection.value === 'evidence') return `${props.evidenceArchives.length} 份封存 / 紙上研究`
  if (activeSection.value === 'memory') return 'OpenClaw / Obsidian 事後檢討'
  if (activeSection.value === 'risk') return `${displayStatus(props.guardrails?.status || 'LOCAL')} / ${props.guardrails?.reason || '本機檢查'}`
  return `${props.dataHealth.quoteCoverage} / ${props.dataHealth.quoteSource}`
})
const streamLabel = computed(() => {
  const status = props.socketStatus || 'idle'
  if (status === 'open') return `即時 ${props.socketMessageCount || 0}/${props.socketFlushCount || 0}`
  if (status === 'connecting') return '即時連線中'
  if (status === 'error') return '即時錯誤'
  return '即時離線'
})
const dataHealthStatus = computed(() => {
  if (props.dataHealth.status) return props.dataHealth.status
  if (props.dataHealth.quoteSource.includes('fallback')) return 'FALLBACK'
  if (props.dataHealth.missingSymbols.length) return 'DEGRADED'
  return 'OK'
})
const dataHealthTone = computed(() => {
  if (dataHealthStatus.value === 'OK') return 'ok'
  if (dataHealthStatus.value === 'DEGRADED') return 'warn'
  return 'bad'
})
const dataHealthProvider = computed(() => props.dataHealth.quoteProvider || props.dataHealth.quoteSource || '未知')
const dataHealthLabel = computed(() => {
  const latency = typeof props.dataHealth.quoteLatencyMs === 'number'
    ? `${Math.round(props.dataHealth.quoteLatencyMs)}ms`
    : '延遲 n/a'
  const delay = props.dataHealth.delayed === false ? '即時' : '延遲'
  return `${displayStatus(dataHealthStatus.value)} ${props.dataHealth.quoteCoverage} · ${dataHealthProvider.value} · ${latency} · ${delay}`
})
const dataHealthTitle = computed(() => {
  const lines = [
    `狀態：${displayStatus(dataHealthStatus.value)}`,
    `來源：${props.dataHealth.quoteSource}`,
    `覆蓋：${props.dataHealth.quoteCoverage}`,
    `股票池：${props.dataHealth.stockUniverseSize || props.dataHealth.universeSize || 'n/a'} 檔`,
    `延遲：${props.dataHealth.quoteLatencyMs ?? 'n/a'}ms`,
    `回測：${props.dataHealth.backtestSource}`,
  ]
  if (props.dataHealth.fallbackSymbols?.length) lines.push(`備援標的：${props.dataHealth.fallbackSymbols.join(', ')}`)
  if (props.dataHealth.missingSymbols.length) lines.push(`缺漏：${props.dataHealth.missingSymbols.join(', ')}`)
  if (props.dataHealth.providerErrors?.length) lines.push(`來源錯誤：${displayDiagnostic(props.dataHealth.providerErrors.join(' | '))}`)
  return lines.join('\n')
})
const dataTruthRows = computed<QuantLabDataTruthItem[]>(() => {
  const rows = props.dataHealth.dataTruth?.length
    ? [...props.dataHealth.dataTruth]
    : [
      {
        area: 'Quotes',
        mode: dataHealthStatus.value === 'OK' ? 'real' : dataHealthStatus.value === 'DEGRADED' ? 'partial' : 'mock',
        source: props.dataHealth.quoteSource,
        detail: props.dataHealth.quoteCoverage,
      },
      {
        area: 'Candles',
        mode: 'mock',
        source: 'generated-client-bars',
        detail: '前端視覺用 K 線。',
      },
      {
        area: 'Paper',
        mode: 'real',
        source: 'local-server-state',
        detail: '僅紙上帳戶。',
      },
    ] as QuantLabDataTruthItem[]

  if (props.candleTruth) {
    const index = rows.findIndex(item => item.area.toLowerCase() === 'candles')
    if (index >= 0) rows[index] = props.candleTruth
    else rows.push(props.candleTruth)
  }

  return rows
})
const dataTruthSummaryRows = computed(() => dataTruthRows.value.map(row => {
  const mode = row.mode
  const use =
    mode === 'real'
      ? '可用於紙上自動化'
      : mode === 'partial'
        ? '需風控確認'
        : mode === 'fallback'
          ? '僅供分析'
          : '僅供視覺測試'
  const tone =
    mode === 'real'
      ? 'positive'
      : mode === 'partial'
        ? 'warning'
        : 'negative'
  return {
    ...row,
    use,
    tone,
  }
}))
const modeBoundaryRows = computed(() => [
  {
    label: '回測層',
    source: props.dataHealth.backtestSource,
    status: props.dataHealth.backtestSource.toLowerCase().includes('mock') ? '僅參考' : '已連歷史資料',
    detail: '只驗證策略假設，不產生今日買賣。',
    tone: props.dataHealth.backtestSource.toLowerCase().includes('mock') ? 'warning' : 'positive',
  },
  {
    label: '紙上交易層',
    source: props.account.valuationSource || 'local-server-state',
    status: props.guardrails?.status === 'BLOCKED' ? '風控阻擋' : '紙上模式',
    detail: '只更新本機紙上帳戶與日記，不送出券商真實訂單。',
    tone: props.guardrails?.status === 'BLOCKED' ? 'negative' : 'positive',
  },
  {
    label: '推演層',
    source: props.mirofishInference?.status || props.latestSeed?.status || 'not_run',
    status: props.mirofishInference ? displayConfidence(props.mirofishInference.confidence) : props.latestSeed ? '種子已建' : '未執行',
    detail: '只產生情境支持/反對理由，不能直接改寫交易或風控。',
    tone: props.mirofishInference?.confidence === 'high' ? 'positive' : props.latestSeed ? 'warning' : 'neutral',
  },
])
const providerStatusRows = computed(() => props.dataHealth.providerStatus || [])
const providerSettingRows = computed(() => props.providerSettings?.providers || [])
const providerSetupRows = computed(() => [
  {
    provider: 'alpaca',
    purpose: '即時報價 / 盤中 OHLCV',
    env: 'ALPACA_API_KEY + ALPACA_SECRET_KEY',
  },
  {
    provider: 'polygon',
    purpose: '備援報價 / 聚合 OHLCV',
    env: 'POLYGON_API_KEY',
  },
  {
    provider: 'yahoo-finance',
    purpose: '匿名報價備援',
    env: '不需金鑰，可能限流',
  },
  {
    provider: 'stooq',
    purpose: '延遲公開報價 / 日 K',
    env: '不需金鑰，僅延遲日線',
  },
])
const providerEnvPathLabel = computed(() => props.providerSettings?.envPath || '目前 profile .env')
const configuredProvidersLabel = computed(() => {
  const count = providerSettingRows.value.filter(provider => provider.configured).length
  return `${count}/${providerSettingRows.value.length || 2} 已設定`
})
const providerTestLabel = computed(() => {
  if (props.testingProviderFeeds) return '測試中'
  if (!props.providerTest) return '尚未測試'
  return `${displayStatus(props.providerTest.status)} ${props.providerTest.symbol} ${props.providerTest.timeframe}`
})
const candleTruthLabel = computed(() => {
  const row = props.candleTruth || dataTruthRows.value.find(item => item.area.toLowerCase() === 'candles')
  if (!row) return `${props.snapshotSource} ${props.snapshotGeneratedAt}`
  if (props.loadingCandles) return '載入 K 線'
  if (!props.candles.length) return '無真實 K 線'
  return `${displayTruthMode(row.mode)} K 線`
})
function truthModeClass(mode: string): string {
  if (mode === 'real') return 'positive'
  if (mode === 'partial') return 'warning'
  return 'negative'
}
function providerFieldMask(provider: string, key: string): string {
  const row = providerSettingRows.value.find(item => item.provider === provider)
  return row?.fields.find(field => field.key === key)?.mask || 'not set'
}
function providerProbeClass(status: string): string {
  if (status === 'ok') return 'positive'
  if (status === 'missing-key' || status === 'skipped' || status === 'partial') return 'warning'
  return 'negative'
}
function providerStatusClass(status: string): string {
  if (status === 'ok' || status === 'ready') return 'positive'
  if (status === 'missing-key' || status === 'skipped' || status === 'partial') return 'warning'
  return 'negative'
}
function saveProviderKeys(): void {
  const payload: SaveQuantLabProviderSettingsPayload = {
    alpacaKeyId: providerKeyForm.value.alpacaKeyId.trim(),
    alpacaSecretKey: providerKeyForm.value.alpacaSecretKey.trim(),
    polygonApiKey: providerKeyForm.value.polygonApiKey.trim(),
  }
  if (!payload.alpacaKeyId && !payload.alpacaSecretKey && !payload.polygonApiKey) return
  emit('saveProviderSettings', payload)
  providerKeyForm.value = { alpacaKeyId: '', alpacaSecretKey: '', polygonApiKey: '' }
}
function clearProviderKeys(keys: string[]): void {
  emit('saveProviderSettings', { clear: keys })
}
const mirofishStatusTone = computed(() => {
  const status = props.mirofishInference?.status
  if (status === 'submitted' || status === 'report_ready' || status === 'backend_available') return 'positive'
  if (status === 'backend_unavailable' || status === 'error') return 'warning'
  return props.latestSeed ? 'warning' : 'negative'
})
const mirofishStatusLabel = computed(() => {
  if (!props.mirofishInference) return props.latestSeed ? '僅種子' : '等待中'
  return `${displayStatus(props.mirofishInference.status)} / ${displayConfidence(props.mirofishInference.confidence)}`
})
const mirofishSupportLine = computed(() => displayJournalNote(props.mirofishInference?.support?.[0] || '尚未產生支持理由。'))
const mirofishOpposeLine = computed(() => displayJournalNote(props.mirofishInference?.oppose?.[0] || '尚未產生反對理由。'))
const mirofishNeutralLine = computed(() => displayJournalNote(props.mirofishInference?.neutral?.[0] || props.latestSeed?.relativePath || '等待第五階段種子。'))
const mirofishMetaLine = computed(() => {
  const inference = props.mirofishInference
  if (!inference) return props.latestSeed ? props.latestSeed.relativePath || props.latestSeed.path : '尚無種子'
  const backend = inference.backendStatus || inference.backendUrl || '本機推演'
  return displayJournalNote(`${inference.evidenceCount} 筆證據 · ${backend}`)
})
const mirofishGraphStatus = computed(() => {
  const status = props.mirofishTaskStatus
  const task = status?.task
  const project = status?.project
  const rawProgress = typeof task?.progress === 'number'
    ? task.progress
    : task?.status === 'completed' || project?.status === 'graph_completed'
      ? 100
      : 0
  const progress = Math.max(0, Math.min(100, Math.round(rawProgress)))
  const statusText = task?.status || project?.status || props.mirofishInference?.status || 'not_run'
  const tone =
    task?.status === 'completed' || project?.status === 'graph_completed'
      ? 'positive'
      : task?.status === 'failed' || status?.ok === false
        ? 'negative'
        : task?.status || project?.status
          ? 'warning'
          : mirofishStatusTone.value
  const result = task?.result || {}
  const graphId = status?.graphId || (result.graph_id ? String(result.graph_id) : '') || project?.graphId || ''
  return {
    statusText: displayStatus(statusText),
    tone,
    progress,
    graphId,
    taskId: status?.graphTaskId || props.mirofishInference?.graphTaskId || '',
    message: task?.message || project?.status || status?.error || '等待情境圖譜任務。',
  }
})
const mirofishGraphCoverage = computed(() => {
  const summary = props.mirofishGraphSummary
  if (!summary?.trackedNodes.length) return []
  return summary.trackedNodes
    .filter(node => node.present)
    .sort((a, b) => b.degree - a.degree || a.symbol.localeCompare(b.symbol))
    .slice(0, 8)
})
const mirofishGraphSummaryLabel = computed(() => {
  const summary = props.mirofishGraphSummary
  if (!summary) return '圖譜摘要等待中'
  if (!summary.ok) return summary.error || '圖譜摘要不可用'
  return `${summary.nodeCount} 節點 / ${summary.edgeCount} 連線 / ${summary.source}`
})
const activeMiroFishEvidenceTicker = computed(() => activeTicker.value || topSignal.value?.ticker || '')
const activeMiroFishGraphNode = computed(() => {
  const ticker = activeMiroFishEvidenceTicker.value
  if (!ticker) return null
  return props.mirofishGraphSummary?.trackedNodes.find(node => node.symbol === ticker) || null
})
function graphEvidenceNameMatches(value: string, symbol: string, nodeName?: string): boolean {
  const normalized = value.toUpperCase()
  return normalized.includes(symbol.toUpperCase()) || Boolean(nodeName && normalized.includes(nodeName.toUpperCase()))
}
const activeMiroFishEvidenceEdges = computed(() => {
  const node = activeMiroFishGraphNode.value
  if (node?.relatedEdges?.length) return node.relatedEdges.slice(0, 3)
  const ticker = activeMiroFishEvidenceTicker.value
  if (!ticker) return []
  return (props.mirofishGraphSummary?.sampleEdges || [])
    .filter(edge => graphEvidenceNameMatches(edge.source, ticker, node?.name) || graphEvidenceNameMatches(edge.target, ticker, node?.name))
    .slice(0, 3)
})
const activeMiroFishEvidenceLabel = computed(() => {
  const node = activeMiroFishGraphNode.value
  if (!props.mirofishGraphSummary?.ok) return '等待中'
  if (!node) return '未追蹤'
  if (!node.present) return '未找到'
  return `d${node.degree} / ${(node.labels || []).slice(0, 2).join('+') || '節點'}`
})
const activeMiroFishEvidenceSummary = computed(() => {
  const node = activeMiroFishGraphNode.value
  return node?.summary || displayReason(topSignal.value?.reason) || '尚無直接圖譜摘要。'
})
const activeMiroFishEvidenceTone = computed(() => {
  const node = activeMiroFishGraphNode.value
  if (!node?.present) return 'warning'
  if (node.degree >= 30) return 'positive'
  if (node.degree >= 12) return 'warning'
  return 'neutral'
})
const mirofishReadinessLabel = computed(() => {
  if (props.mirofishInference) return `推演信心 ${displayConfidence(props.mirofishInference.confidence)}`
  if (props.latestSeed) return '種子已同步'
  if (dataHealthStatus.value === 'FALLBACK' || dataHealthStatus.value === 'ERROR') return '等待種子'
  return '種子待產生'
})

const averageScore = computed(() => {
  if (!props.topPicks.length) return 0
  return props.topPicks.reduce((sum, pick) => sum + pick.score, 0) / props.topPicks.length
})

const journalRows = computed(() => props.journal.slice(0, 24))
const evidenceRows = computed(() => props.evidenceArchives.slice(0, 18))
const latestEvidence = computed(() => evidenceRows.value[0] || null)

function formatEvidenceTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function evidenceGraphLabel(entry: QuantLabEvidenceArchiveEntry): string {
  if (!entry.graphOk) return '圖譜等待中'
  const size = typeof entry.nodeCount === 'number' && typeof entry.edgeCount === 'number'
    ? `${entry.nodeCount}/${entry.edgeCount}`
    : '圖譜正常'
  return `${size} ${entry.graphSource || ''}`.trim()
}

function evidenceDegreeLabel(entry: QuantLabEvidenceArchiveEntry): string {
  return entry.topDegrees.length
    ? entry.topDegrees.slice(0, 5).map(item => `${item.ticker} d${item.degree}`).join(' / ')
    : '—'
}

function displayTickerLabel(value: string): string {
  const normalized = value.toUpperCase()
  if (normalized === 'MIROFISH') return '情境'
  if (normalized === 'OBSIDIAN') return '封存'
  if (normalized === 'HERMES') return '量化'
  return value
}

function displayJournalNote(value: string): string {
  return redactSensitiveText(value)
    .replace(/MiroFish/gi, '情境引擎')
    .replace(/Obsidian/gi, '封存庫')
    .replace(/Hermes Quant Lab/gi, '量化實驗室')
    .replace(/Hermes/gi, '量化核心')
    .replace(/Paper account reset to/gi, '紙上帳戶已重設為')
    .replace(/No real orders are placed/gi, '未送出任何真實訂單')
    .replace(/paper account/gi, '紙上帳戶')
    .replace(/paper buy/gi, '紙上買入')
    .replace(/paper sell/gi, '紙上賣出')
    .replace(/paper position/gi, '紙上持倉')
    .replace(/paper positions/gi, '紙上持倉')
    .replace(/No open paper position to sell/gi, '沒有可賣出的紙上持倉')
    .replace(/No high-confidence paper buy candidate/gi, '沒有高信心紙上買入候選')
    .replace(/Marked/gi, '已標記')
    .replace(/Saved/gi, '已儲存')
    .replace(/report to/gi, '報告到')
}

const backtestLeaders = computed(() => props.backtests.map((row) => {
  const sharpe = Number.parseFloat(row.sharpe)
  const win = Number.parseFloat(row.win)
  return {
    ...row,
    sharpeValue: Number.isFinite(sharpe) ? sharpe : 0,
    winValue: Number.isFinite(win) ? win : 0,
  }
}))

const riskRows = computed(() => props.account.positions.map((position) => {
  const value = positionValue(position)
  const cost = position.shares * position.avgCost
  const pnlPct = cost > 0 ? ((value - cost) / cost) * 100 : 0
  const weight = equity.value > 0 ? (value / equity.value) * 100 : 0
  const pick = props.topPicks.find(item => item.ticker === position.ticker)
  const status = weight > 20 ? 'OVER LIMIT' : pick?.risk === 'H' ? 'HIGH RISK' : 'OK'

  return {
    ticker: position.ticker,
    value,
    weight,
    pnlPct,
    risk: pick?.risk || 'M',
    stop: position.stop,
    status,
  }
}))

const riskChecks = computed(() => {
  if (props.guardrails?.checks?.length) {
    const priority = new Map([
      ['data-health', 0],
      ['paper-price-source', 1],
      ['vix-spike', 2],
      ['qqq-trend', 3],
      ['ten-year-rise', 4],
      ['daily-loss', 5],
      ['drawdown', 6],
      ['positions', 7],
      ['single-name-cap', 8],
      ['stop-loss', 9],
      ['backtest-health', 10],
      ['ai-authority', 11],
      ['account-guard', 12],
    ])
    return [...props.guardrails.checks]
      .sort((a, b) => (priority.get(a.key) ?? 99) - (priority.get(b.key) ?? 99))
      .slice(0, 10)
      .map(check => ({
      label: check.label,
      value: check.status === 'PASS' ? check.value : `${displayStatus(check.status)} ${check.value}`,
      tone: check.status === 'BLOCK' ? 'negative' : check.status === 'WARN' ? 'warning' : 'positive',
    reason: displayDiagnostic(check.reason),
    }))
  }

  const highRiskPicks = props.topPicks.filter(pick => pick.risk === 'H').length
  const buysToday = Object.keys(props.guardrails?.buysToday || {}).length
  return [
    { label: 'Guard', value: displayStatus(props.guardrails?.status || 'LOCAL'), tone: props.guardrails?.status === 'BLOCKED' ? 'negative' : 'positive', reason: props.guardrails?.reason || '' },
    { label: 'Daily', value: `${(props.guardrails?.dailyReturnPct ?? 0).toFixed(2)}%`, tone: (props.guardrails?.dailyReturnPct ?? 0) <= -2 ? 'negative' : 'positive', reason: '單日紙上虧損限制。' },
    { label: 'Drawdown', value: `${maxDrawdown.value.toFixed(2)}%`, tone: maxDrawdown.value <= -10 ? 'negative' : maxDrawdown.value <= -5 ? 'warning' : 'positive', reason: '紙上帳戶最大回撤。' },
    { label: 'Positions', value: `${props.account.positions.length}/5`, tone: props.account.positions.length > 5 ? 'negative' : 'positive', reason: '紙上持倉數上限。' },
    { label: 'Repeat Buys', value: `${buysToday}`, tone: buysToday ? 'warning' : 'positive', reason: '同日重複紙上買入。' },
    { label: 'High Risk', value: `${highRiskPicks}`, tone: highRiskPicks >= 3 ? 'warning' : 'neutral', reason: '高風險觀察清單數量。' },
  ]
})

const prohibitedRiskLines = computed(() => props.guardrails?.prohibited || [])
const actionAuditRows = computed(() => actionAuditLog.value.slice(0, 8).map(entry => ({
  ...entry,
  time: new Date(entry.timestamp).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }),
  ticker: typeof entry.payload.ticker === 'string' ? entry.payload.ticker : '—',
  summary: displayDiagnostic(entry.reason || entry.raw || JSON.stringify(entry.payload)),
})))

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function availableShellHeight(): number {
  return shellRef.value?.getBoundingClientRect().height || window.innerHeight || 900
}

function maxTopHeightFor(bottom: number): number {
  const available = availableShellHeight() - HEADER_HEIGHT - bottom - (SPLITTER_HEIGHT * 2) - MIN_MIDDLE_HEIGHT
  return Math.max(MIN_TOP_HEIGHT, Math.min(MAX_TOP_HEIGHT, available))
}

function maxBottomHeightFor(top: number): number {
  const available = availableShellHeight() - HEADER_HEIGHT - top - (SPLITTER_HEIGHT * 2) - MIN_MIDDLE_HEIGHT
  return Math.max(MIN_BOTTOM_HEIGHT, Math.min(MAX_BOTTOM_HEIGHT, available))
}

function applyTopPanelMode(mode: TopPanelMode) {
  topPanelMode.value = mode
  if (mode === 'compact') topHeight.value = clamp(118, MIN_TOP_HEIGHT, maxTopHeightFor(bottomHeight.value))
  if (mode === 'normal') topHeight.value = clamp(230, MIN_TOP_HEIGHT, maxTopHeightFor(bottomHeight.value))
  if (mode === 'expanded') topHeight.value = clamp(340, MIN_TOP_HEIGHT, maxTopHeightFor(bottomHeight.value))
}

function startResize(target: ResizeTarget, event: MouseEvent) {
  event.preventDefault()
  if (target === 'top' && topPanelMode.value === 'collapsed') {
    topPanelMode.value = 'normal'
  }
  resizeTarget = target
  resizeStartY = event.clientY
  resizeStartTop = topHeight.value
  resizeStartBottom = bottomHeight.value
  isDragging.value = true
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', handleResizeMove)
  window.addEventListener('mouseup', stopResize)
}

function handleResizeMove(event: MouseEvent) {
  if (!resizeTarget) return
  const deltaY = event.clientY - resizeStartY
  if (resizeTarget === 'top') {
    topPanelMode.value = 'normal'
    topHeight.value = clamp(resizeStartTop + deltaY, MIN_TOP_HEIGHT, maxTopHeightFor(bottomHeight.value))
    return
  }
  bottomHeight.value = clamp(resizeStartBottom - deltaY, MIN_BOTTOM_HEIGHT, maxBottomHeightFor(visibleTopHeight.value))
}

function stopResize() {
  resizeTarget = null
  isDragging.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', handleResizeMove)
  window.removeEventListener('mouseup', stopResize)
}

function handleGraphNodeClick(node: { ticker: string | null; label: string; type: string }) {
  if (!node.ticker || node.type === 'macro' || node.type === 'risk') return
  setActiveTicker(node.ticker)
  activeSection.value = 'overview'
}

function selectTicker(ticker: string) {
  setActiveTicker(ticker)
}

function tickerFromPayload(payload: Record<string, unknown>): string {
  return typeof payload.ticker === 'string' ? payload.ticker.trim().toUpperCase() : ''
}

function stringFromPayload(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const value = payload[key]
  return typeof value === 'string' ? value.trim() : fallback
}

function numberFromPayload(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeJournalAction(value: unknown): TerminalJournalAction {
  const action = typeof value === 'string' ? value.trim().toUpperCase() : 'WATCH'
  return ['BUY', 'SELL', 'HOLD', 'WATCH', 'MARK', 'RESET'].includes(action)
    ? action as TerminalJournalAction
    : 'WATCH'
}

function addJournalFromAction(payload: Record<string, unknown>) {
  const ticker = tickerFromPayload(payload) || 'AI'
  const action = normalizeJournalAction(payload.action)
  const note = stringFromPayload(payload, 'note') || stringFromPayload(payload, 'reason') || 'AI 終端動作日記。'
  emit('addJournal', { ticker, action, note })
  activeSection.value = 'journal'
}

function setAlertFromAction(payload: Record<string, unknown>) {
  const ticker = tickerFromPayload(payload) || activeTicker.value || 'MARKET'
  const condition = stringFromPayload(payload, 'condition') || '手動警報'
  const price = numberFromPayload(payload, 'price')
  const note = stringFromPayload(payload, 'note') || stringFromPayload(payload, 'reason')
  actionAlerts.value = [{
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
    ticker,
    condition,
    price,
    note,
  }, ...actionAlerts.value].slice(0, 6)
  emit('addJournal', {
    ticker,
    action: 'WATCH',
    note: `已設定警報：${condition}${price !== null ? ` @ ${formatCurrency(price)}` : ''}${note ? `。${note}` : ''}`,
  })
  activeSection.value = 'risk'
}

watch(latestAction, (action) => {
  if (!action) return

  if (action.type === 'CHANGE_TICKER') {
    const ticker = tickerFromPayload(action.payload)
    if (ticker) {
      setActiveTicker(ticker)
      activeSection.value = 'overview'
    }
  }

  if (action.type === 'SIMULATE_TRADE') {
    const ticker = tickerFromPayload(action.payload)
    if (ticker) setActiveTicker(ticker)
    emit('addJournal', {
      ticker: ticker || 'AI',
      action: 'MARK',
      note: `AI 要求僅做紙上模擬。方向：${stringFromPayload(action.payload, 'side', 'MARK')}。${stringFromPayload(action.payload, 'reason')}`.trim(),
    })
    activeSection.value = 'journal'
  }

  if (action.type === 'ADD_JOURNAL') {
    addJournalFromAction(action.payload)
  }

  if (action.type === 'SET_ALERT') {
    setAlertFromAction(action.payload)
  }
})

onBeforeUnmount(() => {
  stopResize()
})
</script>

<template>
  <section
    ref="shellRef"
    class="terminal-shell"
    :class="[`top-mode-${topPanelMode}`, { 'is-dragging': isDragging }]"
  >
    <header class="ticker-tape">
      <div class="tape-viewport">
        <div class="tape-track">
          <span
            v-for="(item, index) in tapeLoop"
            :key="`${item.label}-${index}`"
            class="tape-item"
            :class="`tone-${item.tone}`"
          >
            <b>{{ item.label }}</b>
            <strong>{{ item.value }}</strong>
          </span>
        </div>
      </div>
      <div class="data-health-pill" :class="`tone-${dataHealthTone}`" :title="dataHealthTitle">
        <span class="health-dot"></span>
        <strong>{{ displayStatus(dataHealthStatus) }}</strong>
        <em>{{ dataHealthLabel }}</em>
      </div>
      <div class="top-layout-controls" :title="topPanelModeLabel" aria-label="上方資訊區大小">
        <span>上方</span>
        <button
          v-for="mode in topPanelModes"
          :key="mode.key"
          :class="{ active: topPanelMode === mode.key }"
          :title="mode.title"
          @click="applyTopPanelMode(mode.key)"
        >
          {{ mode.label }}
        </button>
      </div>
      <nav class="section-tabs" aria-label="量化實驗室視圖">
        <button
          v-for="section in sectionTabs"
          :key="section.key"
          :class="{ active: activeSection === section.key }"
          @click="activeSection = section.key"
        >
          {{ section.label }}
        </button>
      </nav>
    </header>

    <section class="top-row" :class="`mode-${topPanelMode}`" :style="topPanelStyle">
      <button class="top-summary-bar" @click="applyTopPanelMode('normal')">
        <span>上方已隱藏</span>
        <strong>{{ formatCompactCurrency(equity) }}</strong>
        <em>{{ topSignal?.ticker || '標的' }} {{ displayAction(topSignal?.action) }} {{ topSignal?.score || '--' }}</em>
        <b>展開</b>
      </button>
      <section class="terminal-panel wallet-panel">
        <div class="panel-title">
          <span>資金 / 損益</span>
          <strong>{{ accountSourceLabel }}</strong>
        </div>
        <div class="wallet-total" :class="returnPct >= 0 ? 'positive' : 'negative'">
          <FastMoneyText :value="equity" />
        </div>
        <div class="wallet-subline">
          <span>{{ formatPercent(returnPct) }} 淨值</span>
          <span>{{ formatCompactCurrency(exposure) }} 曝險</span>
          <span>{{ streamLabel }}</span>
        </div>
        <div class="wallet-grid">
          <div>
            <span>現金</span>
            <strong>{{ formatCurrency(account.cash) }}</strong>
          </div>
          <div>
            <span>持倉</span>
            <strong>{{ account.positions.length }}</strong>
          </div>
          <div>
            <span>勝率</span>
            <strong>{{ winRate.toFixed(0) }}%</strong>
          </div>
          <div>
            <span>獲利因子</span>
            <strong>{{ Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞' }}</strong>
          </div>
        </div>
      </section>

      <section class="terminal-panel candle-panel">
        <div class="panel-title candle-title">
          <span>{{ topSignal?.ticker || '標的' }} / 盤中訊號</span>
          <div class="candle-title-tools">
            <button
              v-for="timeframe in candleTimeframeOptions"
              :key="timeframe"
              :class="{ active: candleTimeframe === timeframe }"
              :disabled="loadingCandles"
              @click="emit('changeCandleTimeframe', timeframe)"
            >
              {{ timeframe.toUpperCase() }}
            </button>
            <strong>{{ focusMode && activeTicker ? `聚焦 ${activeTicker}` : candleTruthLabel }}</strong>
          </div>
        </div>
        <div class="candle-chart-wrap">
          <TerminalCandlestickChart
            class="terminal-chart"
            :symbol="topSignal?.ticker || 'SPY'"
            :action="topSignal?.action || 'WATCH'"
            :score="topSignal?.score || '--'"
            :price="topSignal?.price || null"
            :candles="candles"
          />
          <div v-if="!candles.length" class="no-real-candles">
            <strong>{{ loadingCandles ? '載入 K 線' : '無真實 K 線' }}</strong>
            <span>{{ candleStatus || candleSource }}</span>
          </div>
        </div>
      </section>

      <section class="terminal-panel setup-panel">
        <div class="panel-title">
          <span>交易設定</span>
          <strong>{{ displayStatus(guardrails?.status || 'LOCAL') }}</strong>
        </div>
        <div class="setup-mode" :class="tradeModeClass">{{ tradeMode }}</div>
        <div class="setup-score">
          <strong>{{ topSignal?.score || '--' }}</strong>
          <span>{{ topSignal?.ticker || '無訊號' }}</span>
        </div>
        <div class="setup-copy">
          <p>{{ decision.action }}</p>
          <small>{{ decision.invalidation }}</small>
        </div>
        <div v-if="focusMode && activeTicker" class="focus-strip">
          <span>聚焦</span>
          <strong>{{ activeTicker }}</strong>
          <button @click="clearFocus">清除</button>
        </div>
        <div class="setup-actions">
          <button :disabled="loadingSnapshot" @click="emit('refresh')">{{ loadingSnapshot ? '同步中' : '刷新' }}</button>
          <button :disabled="!!runningBrief" @click="emit('runBrief', 'premarket')">開盤前</button>
          <button :disabled="!!runningBrief" @click="emit('runBrief', 'afterclose')">收盤後</button>
          <button :disabled="runningWeeklySummary" @click="emit('runWeeklySummary')">{{ runningWeeklySummary ? '週報中' : '週總結' }}</button>
          <button :disabled="!!paperActionPending" @click="emit('mark')">標記</button>
        </div>
      </section>
    </section>

    <div
      class="row-resizer top-resizer"
      role="separator"
      aria-label="調整上方面板高度"
      aria-orientation="horizontal"
      title="拖曳調整上方面板高度"
      @mousedown="startResize('top', $event)"
    >
      <span></span>
    </div>

    <section class="middle-row terminal-panel">
      <div class="panel-title graph-title">
        <span>{{ middleTitle }}</span>
        <strong>{{ middleMeta }}</strong>
      </div>
      <div v-if="activeSection === 'overview'" class="graph-shell">
        <MiroFishScenarioGraph
          :top-picks="topPicks"
          :market-pulse="marketPulse"
          :decision="decision"
          :guardrails="guardrails"
          :latest-seed="latestSeed"
          :graph-summary="mirofishGraphSummary"
          :journal="journal"
          :positions="account.positions"
          @node-click="handleGraphNodeClick"
        />
        <div class="mirofish-inference-console" :class="mirofishStatusTone">
          <div>
            <span>情境引擎</span>
            <strong>{{ mirofishStatusLabel }}</strong>
          </div>
          <p><b>支持</b>{{ mirofishSupportLine }}</p>
          <p><b>反對</b>{{ mirofishOpposeLine }}</p>
          <p><b>中性</b>{{ mirofishNeutralLine }}</p>
          <small>{{ mirofishMetaLine }}</small>
          <div class="graph-task-line">
            <span>圖譜建構</span>
            <strong :class="mirofishGraphStatus.tone">{{ mirofishGraphStatus.statusText }}</strong>
          </div>
          <div class="graph-task-progress">
            <i><b :class="mirofishGraphStatus.tone" :style="{ width: `${mirofishGraphStatus.progress}%` }" /></i>
            <span>{{ mirofishGraphStatus.progress }}%</span>
            <button :disabled="loadingMiroFishTask" @click="emit('refreshMirofishTask')">
              {{ loadingMiroFishTask ? '...' : '檢查' }}
            </button>
          </div>
          <small v-if="mirofishGraphStatus.graphId">{{ mirofishGraphStatus.graphId }}</small>
          <small v-else>{{ mirofishGraphStatus.message }}</small>
          <div class="graph-summary-line">
            <span>圖譜資料</span>
            <strong :class="props.mirofishGraphSummary?.ok ? 'positive' : 'warning'">{{ mirofishGraphSummaryLabel }}</strong>
            <button :disabled="loadingMiroFishGraph" @click="emit('refreshMirofishGraph')">
              {{ loadingMiroFishGraph ? '...' : '載入' }}
            </button>
          </div>
          <div v-if="mirofishGraphCoverage.length" class="graph-node-strip">
            <span v-for="node in mirofishGraphCoverage" :key="node.symbol" :title="node.summary || node.name || node.symbol">
              {{ node.symbol }} <b>{{ node.degree }}</b>
            </span>
          </div>
          <div v-if="props.mirofishGraphSummary?.ok" class="graph-evidence">
            <div class="graph-evidence-head">
              <span>證據 {{ activeMiroFishEvidenceTicker || '市場' }}</span>
              <strong :class="activeMiroFishEvidenceTone">{{ activeMiroFishEvidenceLabel }}</strong>
            </div>
            <p><b>原因</b>{{ activeMiroFishEvidenceSummary }}</p>
            <div v-if="activeMiroFishEvidenceEdges.length" class="graph-edge-list">
              <span
                v-for="edge in activeMiroFishEvidenceEdges"
                :key="`${edge.source}-${edge.target}-${edge.type}`"
                :title="edge.fact || `${edge.source} -> ${edge.target}`"
              >
                {{ edge.source }} → {{ edge.target }} <b>{{ edge.type }}</b>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="activeSection === 'top10'" class="terminal-section-content">
        <div class="risk-bridge-batch-strip" aria-label="Quant Risk Bridge Batch Controls">
          <div>
            <span>Aurora Risk Bridge Batch</span>
            <strong>Top {{ riskBridgeBatchPicks.length }} sandbox</strong>
            <small>依序送入 MiroFish Arena，只做風險推演，不提交真交易。</small>
          </div>
          <button
            type="button"
            :disabled="runningMiroFish || riskBridgeBatchPicks.length === 0"
            aria-label="Run MiroFish batch risk bridge"
            @click="emit('runMirofishBatch', riskBridgeBatchPicks)"
          >
            批次推演
          </button>
        </div>
        <div class="phase-validation-strip" aria-label="Quant Lab phase validation">
          <div
            v-for="item in phaseValidationItems"
            :key="item.label"
            class="phase-validation-cell"
            :class="`tone-${item.tone}`"
          >
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
            <small>{{ item.detail }}</small>
          </div>
        </div>
        <div class="wf-rolling-strip" aria-label="WF Top5 rolling paper performance">
          <div class="wf-rolling-head">
            <span>WF Top5 Rolling</span>
            <strong>{{ wfRollingPerformance ? `${wfRollingPerformance.snapshotCount} snapshots` : 'no data' }}</strong>
            <small>{{ wfRollingPerformance?.policy || 'top5-reb10-def-strict-vol-risk25' }}</small>
          </div>
          <div v-for="metric in wfRollingMetrics" :key="metric.label" class="wf-rolling-cell">
            <span>{{ metric.label }}</span>
            <strong>{{ metric.avg }}</strong>
            <small>win {{ metric.win }} / αSPY {{ metric.alpha }} / beat {{ metric.outperform }} / n={{ metric.samples }}</small>
          </div>
          <div class="wf-rolling-cell">
            <span>Turnover</span>
            <strong>{{ formatRatioPercent(wfRollingPerformance?.latestTurnover) }}</strong>
            <small>avg {{ formatRatioPercent(wfRollingPerformance?.avgTurnover) }}</small>
          </div>
          <div class="wf-rolling-cell">
            <span>Daily proxy</span>
            <strong>{{ wfRollingSharpeText }}</strong>
            <small>Sharpe / n={{ wfRollingPerformance?.dailySampleCount ?? 0 }}</small>
          </div>
          <div class="wf-rolling-change">{{ wfRollingChangeText }}</div>
        </div>
        <div class="wf-rolling-strip ai-bottleneck-rolling-strip" aria-label="AI Bottleneck rolling paper performance">
          <div class="wf-rolling-head">
            <span>AI Bottleneck Rolling</span>
            <strong>{{ aiBottleneckRollingPerformance ? `${aiBottleneckRollingPerformance.snapshotCount} snapshots` : 'no data' }}</strong>
            <small>{{ aiBottleneckRollingPerformance?.policy || 'ai-bottleneck-top5-equal-weight' }}</small>
          </div>
          <div v-for="metric in aiBottleneckRollingMetrics" :key="metric.label" class="wf-rolling-cell">
            <span>{{ metric.label }}</span>
            <strong>{{ metric.avg }}</strong>
            <small>win {{ metric.win }} / αSPY {{ metric.alpha }} / beat {{ metric.outperform }} / n={{ metric.samples }}</small>
          </div>
          <div class="wf-rolling-cell">
            <span>Turnover</span>
            <strong>{{ formatRatioPercent(aiBottleneckRollingPerformance?.latestTurnover) }}</strong>
            <small>avg {{ formatRatioPercent(aiBottleneckRollingPerformance?.avgTurnover) }}</small>
          </div>
          <div class="wf-rolling-change">{{ aiBottleneckRollingChangeText }}</div>
        </div>
        <div class="wf-rolling-strip youzi-cycle-rolling-strip" aria-label="Youzi Cycle rolling paper performance">
          <div class="wf-rolling-head">
            <span>Youzi Cycle Rolling</span>
            <strong>{{ youziCycleRollingPerformance ? `${youziCycleRollingPerformance.snapshotCount} snapshots` : 'no data' }}</strong>
            <small>{{ youziCycleRollingPerformance?.policy || 'youzi-cycle-top5-equal-weight' }}</small>
          </div>
          <div v-for="metric in youziCycleRollingMetrics" :key="metric.label" class="wf-rolling-cell">
            <span>{{ metric.label }}</span>
            <strong>{{ metric.avg }}</strong>
            <small>win {{ metric.win }} / αSPY {{ metric.alpha }} / beat {{ metric.outperform }} / n={{ metric.samples }}</small>
          </div>
          <div class="wf-rolling-cell">
            <span>Turnover</span>
            <strong>{{ formatRatioPercent(youziCycleRollingPerformance?.latestTurnover) }}</strong>
            <small>avg {{ formatRatioPercent(youziCycleRollingPerformance?.avgTurnover) }}</small>
          </div>
          <div class="wf-rolling-change">{{ youziCycleRollingChangeText }}</div>
        </div>
        <table class="terminal-table detail-table">
          <thead>
            <tr>
              <th>#</th>
              <th>代號</th>
              <th>分數</th>
              <th>動作</th>
              <th>估值風控</th>
              <th>趨勢</th>
              <th>風險</th>
              <th>價格</th>
              <th>理由</th>
              <th>紙上</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(pick, index) in topPicks"
              :key="pick.ticker"
              :class="{ focused: activeTicker === pick.ticker }"
              @click="selectTicker(pick.ticker)"
            >
              <td>{{ index + 1 }}</td>
              <td><strong>{{ pick.ticker }}</strong></td>
              <td class="score-cell">
                <span>{{ pick.score }}</span>
                <small v-if="pick.scoreBreakdown?.valuation">估值調整 {{ pick.scoreBreakdown.valuation.delta || '±0' }}</small>
                <i><b :style="{ width: `${Math.min(pick.score, 100)}%` }" /></i>
              </td>
              <td :class="pick.action === 'BUY' ? 'positive' : pick.action === 'WATCH' ? 'warning' : 'neutral'">{{ displayAction(pick.action) }}</td>
              <td class="valuation-risk-cell" :class="valuationRiskTone(pick.scoreBreakdown?.valuation?.riskTier)">
                <template v-if="pick.scoreBreakdown?.valuation">
                  <strong>{{ displayValuationRiskTier(pick.scoreBreakdown.valuation.riskTier) }}</strong>
                  <small>
                    cap {{ pick.scoreBreakdown.valuation.scoreCap ?? 'n/a' }} / max {{ displayAction(pick.scoreBreakdown.valuation.maxAction) }}
                  </small>
                  <em v-if="pick.scoreBreakdown.valuation.warning">{{ pick.scoreBreakdown.valuation.warning }}</em>
                </template>
                <template v-else>—</template>
              </td>
              <td :class="pick.trend.startsWith('+') ? 'positive' : pick.trend.startsWith('-') ? 'negative' : 'neutral'">{{ pick.trend }}</td>
              <td :class="pick.risk === 'H' ? 'negative' : pick.risk === 'M' ? 'warning' : 'positive'">{{ displayRisk(pick.risk) }}</td>
              <td>{{ formatCurrency(pick.price) }}</td>
              <td>{{ displayReason(pick.reason) }}</td>
              <td class="trade-buttons">
                <button
                  :class="{ 'valuation-blocked': !valuationAllowsPaperBuy(pick) }"
                  :disabled="paperBuyDisabled(pick)"
                  :title="paperBuyBlockReason(pick)"
                  @click.stop="emit('paperBuy', pick)"
                >
                  買
                </button>
                <button :disabled="!!paperActionPending" @click.stop="emit('paperSell', pick.ticker)">賣</button>
                <button
                  class="risk-bridge-button"
                  :disabled="runningMiroFish"
                  :aria-label="`Run MiroFish risk bridge for ${pick.ticker}`"
                  @click.stop="emit('runMirofishForPick', pick)"
                >
                  推演
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="activeSection === 'journal'" class="terminal-section-content journal-console">
        <div v-for="entry in journalRows" :key="`${entry.time}-${entry.ticker}-${entry.action}-${entry.note}`" class="journal-line">
          <time>{{ entry.time }}</time>
          <strong :class="entry.action === 'BUY' ? 'positive' : entry.action === 'SELL' ? 'negative' : 'warning'">
            {{ displayTickerLabel(entry.ticker) }} {{ displayAction(entry.action) }}
          </strong>
          <p>{{ displayJournalNote(entry.note) }}</p>
        </div>
        <div v-if="journalRows.length === 0" class="empty-line">目前尚無日記紀錄。</div>
      </div>

      <div v-else-if="activeSection === 'pnl'" class="terminal-section-content pnl-console">
        <PnLDashboard />
      </div>

      <div v-else-if="activeSection === 'backtest'" class="terminal-section-content backtest-console">
        <table class="terminal-table detail-table">
          <thead>
            <tr>
              <th>策略</th>
              <th>年化</th>
              <th>夏普</th>
              <th>最大回撤</th>
              <th>勝率</th>
              <th>狀態</th>
              <th>強度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in backtestLeaders" :key="row.strategy">
              <td><strong>{{ row.strategy }}</strong></td>
              <td class="positive">{{ row.cagr }}</td>
              <td>{{ row.sharpe }}</td>
              <td class="warning">{{ row.maxDd }}</td>
              <td>{{ row.win }}</td>
              <td>{{ displayStatus(row.status) }}</td>
              <td class="score-cell">
                <span>{{ row.sharpeValue.toFixed(2) }}</span>
                <i><b :style="{ width: `${Math.min(100, row.sharpeValue * 70)}%` }" /></i>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="backtest-hints">
          <span>最佳條件：VIX 偏低 / QQQ 高於趨勢</span>
          <span>失效條件：殖利率急升 / 回撤風控觸發</span>
          <span>僅供紙上驗證使用</span>
        </div>
      </div>

      <div v-else-if="activeSection === 'data'" class="terminal-section-content data-console">
        <div class="truth-summary-grid">
          <div
            v-for="row in dataTruthSummaryRows"
            :key="`truth-summary-${row.area}`"
            class="truth-summary-card"
            :class="row.tone"
            :title="displayDiagnostic(row.detail)"
          >
            <span>{{ displayArea(row.area) }}</span>
            <strong>{{ displayTruthMode(row.mode) }}</strong>
            <em>{{ row.use }}</em>
          </div>
        </div>
        <div class="mode-boundary-grid">
          <div v-for="row in modeBoundaryRows" :key="row.label" class="mode-boundary-cell" :class="row.tone">
            <span>{{ row.label }}</span>
            <strong>{{ row.status }}</strong>
            <em>{{ row.source }}</em>
            <p>{{ row.detail }}</p>
          </div>
        </div>
        <div class="data-feed-grid">
          <section>
            <div class="console-title">
              <span>資料真實性</span>
              <strong>{{ displayStatus(dataHealthStatus) }}</strong>
            </div>
            <table class="terminal-table">
              <thead>
                <tr>
                  <th>區域</th>
                  <th>模式</th>
                  <th>來源</th>
                  <th>細節</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in dataTruthSummaryRows" :key="`truth-${row.area}`">
                  <td><strong>{{ displayArea(row.area) }}</strong></td>
                  <td :class="truthModeClass(row.mode)">{{ displayTruthMode(row.mode) }}</td>
                  <td>{{ row.source }}</td>
                  <td>{{ displayDiagnostic(row.detail) }} / {{ row.use }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section>
            <div class="console-title">
              <span>資料源就緒度</span>
              <strong>{{ dataHealthProvider }}</strong>
            </div>
            <table class="terminal-table">
              <thead>
                <tr>
                  <th>來源</th>
                  <th>狀態</th>
                  <th>設定</th>
                  <th>細節</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="provider in providerStatusRows" :key="`provider-${provider.provider}`">
                  <td><strong>{{ provider.provider }}</strong></td>
                  <td :class="providerStatusClass(provider.status)">{{ displayStatus(provider.status) }}</td>
                  <td>{{ provider.configured ? '已設定' : '未設定' }}</td>
                  <td>{{ displayDiagnostic(provider.detail) }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="provider-key-console">
            <div class="console-title">
              <span>本機資料源金鑰</span>
              <strong>{{ configuredProvidersLabel }} / {{ providerTestLabel }}</strong>
            </div>
            <div class="provider-key-grid">
              <label>
                <span>Alpaca 金鑰</span>
                <input
                  v-model="providerKeyForm.alpacaKeyId"
                  type="password"
                  autocomplete="off"
                  :placeholder="providerFieldMask('alpaca', 'ALPACA_API_KEY')"
                >
                <small>只貼 API key id，不要貼 https://paper-api.alpaca.markets/v2。</small>
              </label>
              <label>
                <span>Alpaca 秘密金鑰</span>
                <input
                  v-model="providerKeyForm.alpacaSecretKey"
                  type="password"
                  autocomplete="off"
                  :placeholder="providerFieldMask('alpaca', 'ALPACA_SECRET_KEY')"
                >
                <small>只貼 secret key。</small>
              </label>
              <label>
                <span>Polygon 金鑰</span>
                <input
                  v-model="providerKeyForm.polygonApiKey"
                  type="password"
                  autocomplete="off"
                  :placeholder="providerFieldMask('polygon', 'POLYGON_API_KEY')"
                >
                <small>即使 snapshot 報價受方案限制，aggregates 仍可能可用。</small>
              </label>
              <div class="provider-key-actions">
                <button :disabled="savingProviderSettings" @click="saveProviderKeys">{{ savingProviderSettings ? '儲存中' : '儲存金鑰' }}</button>
                <button :disabled="testingProviderFeeds || savingProviderSettings" @click="emit('testProviderFeeds')">{{ testingProviderFeeds ? '測試中' : '測試資料源' }}</button>
                <button :disabled="savingProviderSettings" @click="clearProviderKeys(['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'APCA_API_KEY_ID', 'APCA_API_SECRET_KEY'])">清除 Alpaca</button>
                <button :disabled="savingProviderSettings" @click="clearProviderKeys(['POLYGON_API_KEY'])">清除 Polygon</button>
              </div>
            </div>
            <div v-if="providerSettingRows.length" class="provider-key-diagnostics">
              <span
                v-for="provider in providerSettingRows"
                :key="`provider-setting-${provider.provider}`"
                :class="providerStatusClass(provider.status)"
                :title="displayDiagnostic(provider.detail || provider.purpose)"
              >
                {{ provider.provider }} {{ displayStatus(provider.status) }}
              </span>
            </div>
            <table v-if="providerTest" class="terminal-table provider-test-table">
              <thead>
                <tr>
                  <th>來源</th>
                  <th>報價</th>
                  <th>報價細節</th>
                  <th>K 線</th>
                  <th>K 線細節</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in providerTest.tests" :key="`provider-test-${row.provider}`">
                  <td><strong>{{ row.provider }}</strong></td>
                  <td :class="providerProbeClass(row.quote.status)">{{ displayStatus(row.quote.status) }}</td>
                  <td>{{ displayDiagnostic(row.quote.detail) }}</td>
                  <td :class="providerProbeClass(row.candles.status)">{{ displayStatus(row.candles.status) }}</td>
                  <td>{{ displayDiagnostic(row.candles.detail) }}</td>
                </tr>
              </tbody>
            </table>
            <p class="provider-key-status" :title="providerEnvPathLabel">
              {{ providerSettingsStatus || providerEnvPathLabel }}
            </p>
          </section>

          <section class="provider-setup">
            <div class="console-title">
              <span>設定名稱</span>
              <strong>僅本機 .env</strong>
            </div>
            <table class="terminal-table">
              <thead>
                <tr>
                  <th>來源</th>
                  <th>用途</th>
                  <th>必要 env</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in providerSetupRows" :key="`setup-${row.provider}`">
                  <td><strong>{{ row.provider }}</strong></td>
                  <td>{{ row.purpose }}</td>
                  <td>{{ row.env }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>

      <div v-else-if="activeSection === 'evidence'" class="terminal-section-content evidence-console">
        <div class="evidence-summary-strip">
          <div>
            <span>最新</span>
            <strong>{{ latestEvidence ? formatEvidenceTime(latestEvidence.createdAt) : '無' }}</strong>
          </div>
          <div>
            <span>圖譜</span>
            <strong>{{ latestEvidence ? evidenceGraphLabel(latestEvidence) : '—' }}</strong>
          </div>
          <div>
            <span>信心</span>
            <strong>{{ displayConfidence(latestEvidence?.confidence) }}</strong>
          </div>
          <div>
            <span>封存</span>
            <strong>{{ evidenceRows.length }}</strong>
          </div>
        </div>
        <table class="terminal-table detail-table evidence-table">
          <thead>
            <tr>
              <th>時間</th>
              <th>階段</th>
              <th>信心</th>
              <th>圖譜</th>
              <th>關聯度</th>
              <th>封存</th>
              <th>摘要</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in evidenceRows" :key="entry.relativePath">
              <td>{{ formatEvidenceTime(entry.createdAt) }}</td>
              <td>{{ displayPhase(entry.phase) }}</td>
              <td :class="entry.confidence === 'high' ? 'positive' : entry.confidence === 'medium' ? 'warning' : 'neutral'">
                {{ displayConfidence(entry.confidence) }}
              </td>
              <td :class="entry.graphOk ? 'positive' : 'warning'">{{ evidenceGraphLabel(entry) }}</td>
              <td>{{ evidenceDegreeLabel(entry) }}</td>
              <td :title="entry.relativePath">{{ entry.fileName }}</td>
              <td>{{ displayJournalNote(entry.summary) }}</td>
            </tr>
            <tr v-if="!evidenceRows.length">
              <td colspan="7" class="empty-line">目前尚無證據封存。請執行開盤前或收盤後簡報。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="activeSection === 'memory'" class="terminal-section-content memory-console">
        <MemoryVaultPanel />
      </div>

      <div v-else class="terminal-section-content risk-console">
        <div class="risk-strip">
          <div v-for="item in riskChecks" :key="item.label" class="risk-cell" :class="item.tone" :title="item.reason">
            <span>{{ displayRiskCheckLabel(item.label) }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </div>
        <div v-if="prohibitedRiskLines.length" class="risk-prohibited-console">
          <div v-for="line in prohibitedRiskLines" :key="line" class="risk-prohibited-line">
            <strong>阻擋</strong>
            <span>{{ line }}</span>
          </div>
        </div>
        <div v-if="actionAlerts.length" class="alert-console">
          <div v-for="alert in actionAlerts" :key="alert.id" class="alert-line">
            <time>{{ alert.time }}</time>
            <strong>{{ alert.ticker }}</strong>
            <span>{{ alert.condition }}</span>
            <em v-if="alert.price !== null">{{ formatCurrency(alert.price) }}</em>
            <p v-if="alert.note">{{ alert.note }}</p>
          </div>
        </div>
        <div v-if="actionAuditRows.length" class="action-audit-console">
          <div class="console-title">
            <span>AI 指令稽核</span>
            <strong>{{ actionAuditRows.length }} 筆</strong>
          </div>
          <div v-for="entry in actionAuditRows" :key="entry.id" class="action-audit-line" :class="entry.status">
            <time>{{ entry.time }}</time>
            <strong>{{ entry.type }}</strong>
            <span>{{ entry.ticker }}</span>
            <em>{{ entry.status === 'accepted' ? '已接受' : '已拒絕' }}</em>
            <p>{{ entry.summary }}</p>
          </div>
        </div>
        <table class="terminal-table detail-table">
          <thead>
            <tr>
              <th>代號</th>
              <th>市值</th>
              <th>權重</th>
              <th>損益</th>
              <th>風險</th>
              <th>停損</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in riskRows"
              :key="row.ticker"
              :class="{ focused: activeTicker === row.ticker }"
              @click="selectTicker(row.ticker)"
            >
              <td><strong>{{ row.ticker }}</strong></td>
              <td>{{ formatCurrency(row.value) }}</td>
              <td>{{ row.weight.toFixed(1) }}%</td>
              <td :class="row.pnlPct >= 0 ? 'positive' : 'negative'">{{ formatPercent(row.pnlPct) }}</td>
              <td :class="row.risk === 'H' ? 'negative' : row.risk === 'M' ? 'warning' : 'positive'">{{ displayRisk(row.risk) }}</td>
              <td>{{ row.stop }}</td>
              <td :class="row.status === 'OK' ? 'positive' : 'warning'">{{ displayRiskStatus(row.status) }}</td>
            </tr>
            <tr v-if="riskRows.length === 0">
              <td colspan="7" class="empty-line">目前沒有紙上持倉。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div
      class="row-resizer bottom-resizer"
      role="separator"
      aria-label="調整下方日誌高度"
      aria-orientation="horizontal"
      title="拖曳調整下方日誌高度"
      @mousedown="startResize('bottom', $event)"
    >
      <span></span>
    </div>

    <section class="bottom-row" :style="bottomPanelStyle">
      <section class="terminal-panel equity-panel">
        <div class="panel-title">
          <span>資金曲線</span>
          <strong>{{ formatPercent(maxDrawdown) }} 回撤</strong>
        </div>
        <TerminalEquityChart class="terminal-chart" :values="equitySeries" />
      </section>

      <section class="terminal-panel trades-panel">
        <div class="panel-title">
          <span>近期交易</span>
          <strong>{{ recentTrades.length }} 筆</strong>
        </div>
        <table>
          <thead>
            <tr>
              <th>時間</th>
              <th>代號</th>
              <th>動作</th>
              <th>備註</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="trade in recentTrades" :key="`${trade.time}-${trade.ticker}-${trade.note}`">
              <td>{{ trade.time }}</td>
              <td>{{ displayTickerLabel(trade.ticker) }}</td>
              <td :class="trade.action === 'BUY' ? 'positive' : trade.action === 'SELL' ? 'negative' : 'warning'">{{ displayAction(trade.action) }}</td>
              <td>{{ displayJournalNote(trade.note) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="terminal-panel analytics-panel">
        <div class="panel-title">
          <span>即時分析</span>
          <strong>{{ mirofishReadinessLabel }}</strong>
        </div>
        <div class="truth-console" aria-label="資料真實性狀態">
          <div v-for="row in dataTruthRows" :key="row.area" class="truth-line" :class="truthModeClass(row.mode)" :title="row.detail">
            <span>{{ displayArea(row.area) }}</span>
            <strong>{{ displayTruthMode(row.mode) }}</strong>
            <em>{{ row.source }}</em>
          </div>
        </div>
        <div v-if="providerStatusRows.length" class="provider-console" aria-label="市場資料源">
          <span
          v-for="provider in providerStatusRows.slice(0, 4)"
          :key="provider.provider"
          :class="providerStatusClass(provider.status)"
          :title="provider.detail"
        >
            {{ provider.provider }} {{ displayStatus(provider.status) }}
          </span>
        </div>
        <div v-for="item in liveAnalytics" :key="item.label" class="analytics-row">
          <div>
            <span>{{ item.label }}</span>
            <strong :class="item.tone">{{ item.value }}%</strong>
          </div>
          <i>
            <b :class="item.tone" :style="{ width: `${Math.min(item.value, 100)}%` }" />
          </i>
        </div>
        <div class="terminal-actions">
          <button :disabled="savingReport" @click="emit('save')">{{ savingReport ? '儲存中' : '封存' }}</button>
          <button :disabled="sendingTelegram" @click="emit('telegram')">{{ sendingTelegram ? '推送中' : 'Telegram' }}</button>
          <button :disabled="runningMiroFish" @click="emit('runMirofish')">{{ runningMiroFish ? '執行中' : '推演' }}</button>
          <button :disabled="!!paperActionPending" @click="emit('reset')">重設</button>
        </div>
        <p v-if="briefStatus || saveStatus || telegramStatus" class="status-line">
          {{ briefStatus || saveStatus || telegramStatus }}
        </p>
      </section>
    </section>
  </section>
</template>

<style scoped lang="scss">
.terminal-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100vh;
  min-height: 0;
  overflow: hidden;
  background: #050505;
  color: #f2f7ff;
  font-family: "JetBrains Mono", "Fira Code", "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

.terminal-shell.is-dragging {
  cursor: row-resize;
  user-select: none;
}

.ticker-tape {
  flex: 0 0 30px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  overflow: hidden;
  border-bottom: 1px solid #333;
  background: #000;
}

.tape-viewport {
  min-width: 0;
  overflow: hidden;
}

.tape-track {
  display: inline-flex;
  min-width: max-content;
  animation: tapeMove 38s linear infinite;
}

.tape-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 14px;
  border-right: 1px solid #222;
  color: #b7c0cc;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;

  b {
    color: #f8fbff;
    font-weight: 800;
  }
}

.data-health-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  max-width: 360px;
  padding: 0 11px;
  border-left: 1px solid #333;
  color: #94a3b8;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;

  strong {
    color: #e8edf7;
    font-weight: 900;
  }

  em {
    overflow: hidden;
    text-overflow: ellipsis;
    font-style: normal;
  }

  &.tone-ok {
    color: #00ff00;
  }

  &.tone-warn {
    color: #ffd700;
  }

  &.tone-bad {
    color: #ff003c;
  }
}

.health-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 10px currentColor;
}

.top-layout-controls {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 30px;
  padding: 0 7px;
  border-left: 1px solid #333;
  background: #050505;
  color: #7f8b98;
  font-size: 9px;
  line-height: 1;
  white-space: nowrap;

  span {
    font-weight: 900;
  }

  button {
    width: 25px;
    height: 20px;
    border: 1px solid #293241;
    border-radius: 0;
    background: #050505;
    color: #9aa7b6;
    font-family: inherit;
    font-size: 9px;
    font-weight: 900;
    line-height: 18px;

    &:not(:disabled) {
      cursor: pointer;
    }

    &.active {
      border-color: rgba(0, 255, 0, 0.8);
      background: #07150f;
      color: #00ff00;
      box-shadow: inset 0 -2px 0 #00ff00;
    }
  }
}

.section-tabs {
  display: flex;
  align-items: center;
  height: 30px;
  border-left: 1px solid #333;
  background: #050505;

  button {
    min-width: 74px;
    height: 30px;
    border: 0;
    border-left: 1px solid #222;
    border-radius: 0;
    background: transparent;
    color: #8794a3;
    font-family: inherit;
    font-size: 10px;
    font-weight: 900;
    text-transform: uppercase;

    &:not(:disabled) {
      cursor: pointer;
    }

    &.active {
      background: #07150f;
      color: #00ff00;
      box-shadow: inset 0 -2px 0 #00ff00;
    }
  }
}

@keyframes tapeMove {
  from {
    transform: translateX(0);
  }

  to {
    transform: translateX(-50%);
  }
}

.top-row,
.bottom-row {
  display: grid;
  grid-template-columns: 0.9fr 1.6fr 1fr;
  flex: 0 0 auto;
  min-height: 0;
  overflow: hidden;
}

.top-row {
  position: relative;
}

.row-resizer {
  position: relative;
  z-index: 7;
  flex: 0 0 4px;
  height: 4px;
  border-top: 1px solid #111827;
  border-bottom: 1px solid #111827;
  background: #050505;
  cursor: row-resize;
  transition: background-color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
}

.row-resizer span {
  position: absolute;
  inset: 1px 0;
  background: #1f2937;
}

.row-resizer:hover,
.row-resizer:active,
.terminal-shell.is-dragging .row-resizer {
  border-color: rgba(0, 255, 136, 0.65);
  background: rgba(0, 255, 136, 0.18);
  box-shadow: 0 0 14px rgba(0, 255, 136, 0.42);
}

.row-resizer:hover span,
.row-resizer:active span,
.terminal-shell.is-dragging .row-resizer span {
  background: #00ff88;
  box-shadow: 0 0 12px rgba(0, 255, 136, 0.75);
}

.top-summary-bar {
  display: none;
}

.top-row.mode-expanded {
  grid-template-columns: 0.85fr 1.85fr 1fr;
}

.top-row.mode-compact {
  grid-template-columns: minmax(220px, 0.72fr) minmax(420px, 1.95fr) minmax(300px, 0.95fr);
}

.top-row.mode-collapsed {
  grid-template-columns: 1fr;
}

.top-row.mode-collapsed > .terminal-panel {
  display: none;
}

.top-row.mode-collapsed .top-summary-bar {
  display: grid;
  grid-template-columns: auto minmax(110px, auto) minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-bottom: 1px solid #333;
  border-radius: 0;
  background:
    linear-gradient(90deg, rgba(0, 255, 0, 0.08), transparent 34%),
    #050505;
  color: #dce5ef;
  font-family: inherit;
  line-height: 1;
  text-align: left;
  cursor: pointer;

  span,
  em,
  b {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    color: #8794a3;
    font-size: 10px;
    font-weight: 900;
  }

  strong {
    color: #00ff00;
    font-size: 16px;
    font-weight: 900;
    text-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
    white-space: nowrap;
  }

  em {
    color: #ffd700;
    font-size: 11px;
    font-style: normal;
    font-weight: 900;
  }

  b {
    color: #00ff00;
    font-size: 10px;
    font-weight: 900;
  }
}

.middle-row {
  min-height: 0;
}

.terminal-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid #333;
  border-bottom: 1px solid #333;
  background: #050505;
}

.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-bottom: 1px solid #222;
  background: #080808;
  font-size: 10px;
  line-height: 1;
  text-transform: uppercase;

  span {
    color: #8f9cab;
  }

  strong {
    overflow: hidden;
    color: #f8fbff;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.candle-title {
  > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.candle-title-tools {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;

  button {
    width: 36px;
    height: 20px;
    border: 1px solid #293241;
    border-radius: 0;
    background: #050505;
    color: #8794a3;
    font-family: inherit;
    font-size: 9px;
    font-weight: 900;

    &.active {
      border-color: rgba(0, 255, 0, 0.7);
      color: #00ff00;
      box-shadow: inset 0 -2px 0 #00ff00;
    }

    &:disabled {
      color: #555;
      cursor: wait;
    }
  }
}

.wallet-panel,
.setup-panel,
.analytics-panel {
  padding-bottom: 8px;
}

.wallet-total {
  padding: 18px 14px 8px;
  font-size: clamp(34px, 4vw, 54px);
  font-weight: 900;
  line-height: 0.95;
  text-shadow: 0 0 18px currentColor;
}

.top-row.mode-expanded .wallet-total {
  font-size: clamp(44px, 4.8vw, 68px);
}

.top-row.mode-compact .wallet-total {
  padding: 10px 12px 5px;
  font-size: clamp(28px, 3vw, 38px);
}

.wallet-subline,
.wallet-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 0 12px;
}

.wallet-subline {
  color: #b7c0cc;
  font-size: 11px;
}

.wallet-grid {
  margin-top: 18px;

  div {
    border: 1px solid #222;
    padding: 8px;
    background: #080808;
  }

  span,
  strong {
    display: block;
    line-height: 1.25;
  }

  span {
    color: #7f8b98;
    font-size: 10px;
    text-transform: uppercase;
  }

  strong {
    margin-top: 5px;
    color: #f8fbff;
    font-size: 13px;
  }
}

.top-row.mode-compact .wallet-subline {
  grid-template-columns: 1fr;
  gap: 3px;
  font-size: 9px;
}

.top-row.mode-compact .wallet-grid {
  display: none;
}

.candle-panel,
.equity-panel {
  display: flex;
  flex-direction: column;
}

.terminal-chart {
  flex: 1;
  width: 100%;
  min-height: 0;
  background: #010101;
}

.candle-chart-wrap {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}

.no-real-candles {
  position: absolute;
  inset: 0;
  display: grid;
  gap: 8px;
  place-content: center;
  border-top: 1px solid #111;
  background:
    repeating-linear-gradient(90deg, rgba(0, 245, 255, 0.06) 0 1px, transparent 1px 64px),
    repeating-linear-gradient(0deg, rgba(0, 245, 255, 0.05) 0 1px, transparent 1px 48px),
    rgba(0, 0, 0, 0.78);
  text-align: center;
  text-transform: uppercase;

  strong {
    color: #ff003c;
    font-size: 18px;
    text-shadow: 0 0 12px #ff003c;
  }

  span {
    max-width: 520px;
    color: #8f9cab;
    font-size: 10px;
    text-transform: none;
  }
}

.setup-mode {
  padding: 16px 14px 0;
  font-size: 18px;
  font-weight: 900;
  text-transform: uppercase;
}

.top-row.mode-compact .setup-mode {
  padding-top: 8px;
  font-size: 12px;
}

.setup-score {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
  align-items: end;
  padding: 2px 14px;

  strong {
    color: #ffd700;
    font-size: clamp(54px, 6vw, 84px);
    line-height: 0.9;
    text-shadow: 0 0 18px #ffd700;
  }

  span {
    padding-bottom: 8px;
    color: #f8fbff;
    font-size: 18px;
    font-weight: 900;
  }
}

.top-row.mode-compact .setup-score {
  gap: 8px;
  padding: 0 12px;

  strong {
    font-size: clamp(38px, 4vw, 52px);
  }

  span {
    padding-bottom: 4px;
    font-size: 14px;
  }
}

.setup-copy {
  padding: 5px 14px 0;

  p,
  small {
    display: block;
    margin: 0;
    color: #c7d0dc;
    line-height: 1.45;
  }

  p {
    font-size: 12px;
  }

  small {
    margin-top: 6px;
    color: #8f9cab;
    font-size: 10px;
  }
}

.top-row.mode-compact .setup-copy {
  max-height: 42px;
  overflow: hidden;
  padding: 2px 12px 0;

  p {
    font-size: 10px;
    line-height: 1.35;
  }

  small {
    display: none;
  }
}

.top-row.mode-compact .focus-strip {
  margin-top: 4px;
  padding: 4px 6px;
}

.focus-strip {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
  margin: 8px 12px 0;
  padding: 6px 8px;
  border: 1px solid rgba(255, 215, 0, 0.35);
  background: rgba(255, 215, 0, 0.06);
  color: #ffd700;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;

  strong {
    color: #f8fbff;
  }

  button {
    min-height: 20px;
    border: 1px solid rgba(255, 215, 0, 0.4);
    border-radius: 0;
    background: #080808;
    color: #ffd700;
    font-family: inherit;
    font-size: 9px;
    font-weight: 900;
    cursor: pointer;
  }
}

.setup-actions,
.terminal-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
  padding: 10px 12px 0;

  button {
    min-height: 26px;
    border: 1px solid #333;
    border-radius: 0;
    background: #090909;
    color: #dce5ef;
    font-family: inherit;
    font-size: 10px;
    font-weight: 800;

    &:not(:disabled) {
      cursor: pointer;
    }

    &:disabled {
      color: #555;
    }
  }
}

.top-row.mode-compact .setup-actions {
  gap: 4px;
  padding-top: 5px;

  button {
    min-height: 21px;
    font-size: 9px;
  }
}

.middle-row {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.graph-title {
  flex: 0 0 28px;
}

.graph-shell,
.terminal-section-content {
  flex: 1;
  min-height: 0;
}

.graph-shell {
  display: flex;
  position: relative;
}

.mirofish-inference-console {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 4;
  display: grid;
  gap: 6px;
  width: min(520px, 38vw);
  max-height: min(330px, 52vh);
  overflow: hidden;
  border: 1px solid #243044;
  background: rgba(0, 0, 0, 0.78);
  box-shadow: 0 0 22px rgba(0, 245, 255, 0.14);
  padding: 9px 10px;
  color: #dce7f4;
  font-size: 10px;
  line-height: 1.35;

  div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: #7f8da1;
    text-transform: uppercase;
  }

  strong {
    color: #f7fbff;
  }

  p {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr);
    gap: 8px;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  b {
    color: #00f5ff;
  }

  small {
    overflow: hidden;
    color: #758195;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .graph-task-line {
    padding-top: 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .graph-task-progress {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 38px 52px;
    align-items: center;
    gap: 8px;
    color: #7f8da1;

    i {
      display: block;
      height: 7px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.04);
    }

    b {
      display: block;
      height: 100%;
      box-shadow: 0 0 10px currentColor;
    }

    span {
      color: #dce7f4;
      font-weight: 900;
      text-align: right;
    }

    button {
      height: 20px;
      border: 1px solid rgba(0, 255, 0, 0.35);
      background: rgba(0, 255, 0, 0.08);
      color: #00ff00;
      font: inherit;
      font-weight: 900;
      cursor: pointer;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.55;
    }
  }

  .graph-summary-line {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) 52px;
    align-items: center;
    gap: 8px;
    padding-top: 3px;
    color: #7f8da1;

    strong {
      overflow: hidden;
      color: #dce7f4;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    button {
      height: 20px;
      border: 1px solid rgba(0, 245, 255, 0.35);
      background: rgba(0, 245, 255, 0.08);
      color: #00f5ff;
      font: inherit;
      font-weight: 900;
      cursor: pointer;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.55;
    }
  }

  .graph-node-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    max-height: 42px;
    overflow: hidden;

    span {
      border: 1px solid rgba(0, 245, 255, 0.22);
      background: rgba(0, 245, 255, 0.07);
      padding: 2px 5px;
      color: #e8ffff;
      white-space: nowrap;
    }

    b {
      color: #00ff00;
    }
  }

  .graph-evidence {
    display: grid;
    gap: 5px;
    padding-top: 5px;
    border-top: 1px solid rgba(0, 245, 255, 0.12);
  }

  .graph-evidence-head {
    display: flex;
    justify-content: space-between;
    gap: 8px;

    strong {
      &.positive {
        color: #00ff00;
        text-shadow: 0 0 10px rgba(0, 255, 0, 0.4);
      }

      &.warning {
        color: #ffd700;
      }

      &.neutral {
        color: #dce7f4;
      }
    }
  }

  .graph-edge-list {
    display: grid;
    gap: 3px;
    max-height: 52px;
    overflow: hidden;

    span {
      overflow: hidden;
      color: #9fb0c4;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    b {
      margin-left: 6px;
      color: #00f5ff;
    }
  }

  &.positive {
    border-color: rgba(0, 255, 0, 0.35);
    box-shadow: 0 0 22px rgba(0, 255, 0, 0.12);
  }

  &.warning {
    border-color: rgba(255, 215, 0, 0.38);
    box-shadow: 0 0 22px rgba(255, 215, 0, 0.12);

    b {
      color: #ffd700;
    }
  }

  &.negative {
    border-color: rgba(255, 0, 60, 0.38);
    box-shadow: 0 0 22px rgba(255, 0, 60, 0.14);

    b {
      color: #ff003c;
    }
  }
}

.middle-row :deep(.scenario-graph) {
  flex: 1;
  height: auto;
  min-height: 0;
  border: 0;
}

.middle-row :deep(.scenario-canvas),
.middle-row :deep(.scenario-svg) {
  height: 100%;
  min-height: 0;
}

.terminal-section-content {
  overflow: auto;
  background:
    linear-gradient(rgba(255, 255, 255, 0.018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.018) 1px, transparent 1px),
    #050505;
  background-size: 48px 48px;
}

.risk-bridge-batch-strip {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(122, 92, 255, 0.24);
  background:
    radial-gradient(circle at 0% 0%, rgba(122, 92, 255, 0.18), transparent 42%),
    linear-gradient(135deg, rgba(14, 16, 26, 0.96), rgba(6, 8, 14, 0.92));
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.26);
}

.risk-bridge-batch-strip span,
.risk-bridge-batch-strip strong,
.risk-bridge-batch-strip small {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.risk-bridge-batch-strip span {
  color: #b8a8ff;
  font-size: 10px;
  font-weight: 950;
  text-transform: uppercase;
}

.risk-bridge-batch-strip strong {
  margin-top: 4px;
  color: #f5f7ff;
  font-size: 13px;
  font-weight: 950;
}

.risk-bridge-batch-strip small {
  margin-top: 3px;
  color: rgba(220, 229, 239, 0.58);
  font-size: 10px;
  font-weight: 720;
}

.risk-bridge-batch-strip button {
  min-height: 32px;
  padding: 0 13px;
  border: 1px solid rgba(122, 92, 255, 0.58);
  border-radius: 999px;
  color: #f5f7ff;
  background:
    linear-gradient(135deg, rgba(122, 92, 255, 0.92), rgba(0, 242, 255, 0.42)),
    #12152b;
  box-shadow: 0 10px 24px rgba(122, 92, 255, 0.18);
  font-family: inherit;
  font-size: 11px;
  font-weight: 950;
  cursor: pointer;
}

.phase-validation-strip {
  position: sticky;
  top: 65px;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(220px, 0.7fr) minmax(360px, 1.3fr);
  border-bottom: 1px solid rgba(0, 242, 255, 0.22);
  background: linear-gradient(135deg, rgba(4, 12, 18, 0.98), rgba(5, 5, 5, 0.94));
}

.phase-validation-cell {
  min-width: 0;
  padding: 9px 12px;
  border-right: 1px solid rgba(255, 255, 255, 0.06);

  span,
  strong,
  small {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    color: #7a8ca3;
    font-size: 9px;
    font-weight: 900;
    text-transform: uppercase;
  }

  strong {
    margin-top: 4px;
    color: #dce5ef;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 13px;
  }

  small {
    margin-top: 3px;
    color: rgba(220, 229, 239, 0.56);
    font-size: 10px;
    font-weight: 700;
  }

  &.tone-up strong {
    color: #00ff9c;
  }

  &.tone-warn strong {
    color: #ffcc00;
  }

  &.tone-down strong {
    color: #ff3b5f;
  }
}
.wf-rolling-strip {
  position: sticky;
  top: 132px;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(180px, 1.2fr) repeat(5, minmax(92px, 0.8fr)) minmax(180px, 1.4fr);
  border-bottom: 1px solid rgba(0, 255, 156, 0.22);
  background:
    radial-gradient(circle at 12% 0%, rgba(0, 255, 156, 0.14), transparent 40%),
    linear-gradient(135deg, rgba(4, 18, 13, 0.98), rgba(5, 5, 5, 0.94));
}

.ai-bottleneck-rolling-strip {
  top: 184px;
  grid-template-columns: minmax(190px, 1.25fr) repeat(4, minmax(92px, 0.8fr)) minmax(180px, 1.4fr);
  border-bottom-color: rgba(86, 170, 255, 0.24);
  background:
    radial-gradient(circle at 12% 0%, rgba(86, 170, 255, 0.16), transparent 42%),
    linear-gradient(135deg, rgba(3, 12, 28, 0.98), rgba(5, 5, 5, 0.94));
}

.youzi-cycle-rolling-strip {
  top: 236px;
  grid-template-columns: minmax(190px, 1.25fr) repeat(4, minmax(92px, 0.8fr)) minmax(180px, 1.4fr);
  border-bottom-color: rgba(255, 192, 86, 0.26);
  background:
    radial-gradient(circle at 12% 0%, rgba(255, 176, 64, 0.16), transparent 42%),
    linear-gradient(135deg, rgba(31, 16, 2, 0.98), rgba(5, 5, 5, 0.94));
}

.wf-rolling-head,
.wf-rolling-cell,
.wf-rolling-change {
  min-width: 0;
  padding: 8px 10px;
  border-right: 1px solid rgba(255, 255, 255, 0.06);

  span,
  strong,
  small {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    color: #7affc2;
    font-size: 9px;
    font-weight: 950;
    text-transform: uppercase;
  }

  strong {
    margin-top: 4px;
    color: #f5f7ff;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 12px;
    font-weight: 950;
  }

  small {
    margin-top: 3px;
    color: rgba(220, 229, 239, 0.56);
    font-size: 10px;
    font-weight: 720;
  }
}

.wf-rolling-change {
  display: flex;
  align-items: center;
  color: rgba(220, 229, 239, 0.72);
  font-size: 10px;
  font-weight: 760;
  line-height: 1.35;
}


.risk-bridge-batch-strip button:disabled {
  border-color: #222;
  color: #555;
  background: #080808;
  box-shadow: none;
  cursor: not-allowed;
}

.terminal-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 10px;

  th,
  td {
    overflow: hidden;
    padding: 7px 8px;
    border-right: 1px solid #191f27;
    border-bottom: 1px solid #191f27;
    color: #dce5ef;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #080808;
    color: #7f8b98;
    font-weight: 900;
    text-transform: uppercase;
  }

  strong {
    color: #f8fbff;
  }

  tr.focused td {
    background: rgba(255, 215, 0, 0.08);
    box-shadow: inset 2px 0 0 #ffd700;
  }

  tbody tr {
    cursor: pointer;
  }
}

.detail-table {
  min-width: 920px;
}

.score-cell {
  span {
    display: inline-block;
    width: 34px;
    color: #f8fbff;
    font-weight: 900;
  }

  small {
    display: block;
    margin: 1px 0 3px;
    color: #ffe08a;
    font-size: 10px;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }

  i {
    display: inline-block;
    width: calc(100% - 42px);
    height: 6px;
    overflow: hidden;
    border: 1px solid #222;
    background: #080808;
    vertical-align: middle;
  }

  b {
    display: block;
    height: 100%;
    background: #00ff00;
    box-shadow: 0 0 12px #00ff00;
  }
}

.valuation-risk-cell {
  min-width: 138px;

  strong,
  small,
  em {
    display: block;
    white-space: nowrap;
  }

  strong {
    font-size: 11px;
    letter-spacing: 0.04em;
  }

  small {
    margin-top: 2px;
    color: #c7d2e0;
    font-size: 10px;
  }

  em {
    max-width: 220px;
    margin-top: 2px;
    overflow: hidden;
    color: #9fb3c8;
    font-size: 10px;
    font-style: normal;
    text-overflow: ellipsis;
  }
}

.trade-buttons {
  display: flex;
  gap: 5px;
  min-width: 102px;

  button {
    width: 24px;
    height: 22px;
    border: 1px solid #333;
    border-radius: 0;
    background: #080808;
    color: #dce5ef;
    font-family: inherit;
    font-size: 10px;
    font-weight: 900;

    &:first-child {
      border-color: rgba(0, 255, 0, 0.45);
      color: #00ff00;
    }

    &:last-child {
      border-color: rgba(255, 0, 60, 0.45);
      color: #ff003c;
    }

    &.risk-bridge-button {
      width: auto;
      min-width: 38px;
      padding: 0 7px;
      border-color: rgba(122, 92, 255, 0.62);
      color: #b8a8ff;
      background:
        linear-gradient(135deg, rgba(122, 92, 255, 0.14), rgba(0, 242, 255, 0.08)),
        #080808;
      box-shadow: inset 0 0 10px rgba(122, 92, 255, 0.08);
    }

    &:disabled {
      border-color: #222;
      color: #555;
    }

    &.valuation-blocked:disabled {
      border-color: rgba(255, 224, 138, 0.35);
      color: #ffe08a;
      cursor: not-allowed;
      opacity: 0.62;
    }
  }
}

.journal-console {
  padding: 2px 0;
}

.journal-line {
  display: grid;
  grid-template-columns: 64px 132px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  min-height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid #191f27;
  font-size: 10px;

  time {
    color: #8f9cab;
  }

  p {
    overflow: hidden;
    margin: 0;
    color: #c7d0dc;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.backtest-hints {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-top: 1px solid #222;

  span {
    overflow: hidden;
    padding: 10px;
    border-right: 1px solid #222;
    color: #8f9cab;
    font-size: 10px;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
}

.truth-summary-grid,
.evidence-summary-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-bottom: 1px solid #222;
  background: #050505;
}

.truth-summary-card,
.evidence-summary-strip > div {
  min-width: 0;
  padding: 8px 10px;
  border-right: 1px solid #222;
  line-height: 1.2;

  span,
  strong,
  em {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    color: #7f8b98;
    font-size: 9px;
    font-weight: 900;
    text-transform: uppercase;
  }

  strong {
    margin-top: 4px;
    font-size: 12px;
    font-weight: 900;
  }

  em {
    margin-top: 3px;
    color: #8f9cab;
    font-size: 9px;
    font-style: normal;
    text-transform: uppercase;
  }
}

.truth-summary-card.positive,
.evidence-summary-strip strong {
  color: #00ff00;
}

.truth-summary-card.warning {
  color: #ffd700;
}

.truth-summary-card.negative {
  color: #ff003c;
}

.mode-boundary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-bottom: 1px solid #222;
  background: #030303;
}

.mode-boundary-cell {
  min-width: 0;
  padding: 8px 10px;
  border-right: 1px solid #222;

  span,
  strong,
  em,
  p {
    display: block;
    overflow: hidden;
    margin: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    color: #7f8b98;
    font-size: 9px;
    font-weight: 900;
    text-transform: uppercase;
  }

  strong {
    margin-top: 4px;
    font-size: 12px;
    font-weight: 900;
  }

  em,
  p {
    margin-top: 3px;
    color: #8f9cab;
    font-size: 9px;
    font-style: normal;
  }

  &.positive strong {
    color: #00ff00;
  }

  &.warning strong {
    color: #ffd700;
  }

  &.negative strong {
    color: #ff003c;
  }
}

.data-feed-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.2fr);
  min-height: calc(100% - 106px);

  section {
    min-width: 0;
    border-right: 1px solid #222;
    border-bottom: 1px solid #222;
  }

  .provider-key-console,
  .provider-setup {
    grid-column: 1 / -1;
  }
}

.evidence-console {
  display: flex;
  flex-direction: column;
}

.evidence-table {
  flex: 1;
  min-height: 0;

  th:nth-child(1),
  td:nth-child(1) {
    width: 100px;
  }

  th:nth-child(2),
  td:nth-child(2),
  th:nth-child(3),
  td:nth-child(3) {
    width: 82px;
  }

  th:nth-child(4),
  td:nth-child(4) {
    width: 135px;
  }

  th:nth-child(5),
  td:nth-child(5) {
    width: 240px;
  }

  th:nth-child(6),
  td:nth-child(6) {
    width: 320px;
  }
}

.provider-key-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid #191f27;

  label {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  span {
    color: #7f8b98;
    font-size: 10px;
    font-weight: 900;
    text-transform: uppercase;
  }

  small {
    overflow: hidden;
    color: #697684;
    font-size: 9px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  input {
    width: 100%;
    min-width: 0;
    height: 28px;
    border: 1px solid #243044;
    border-radius: 0;
    background: #020202;
    color: #f7fbff;
    font-family: inherit;
    font-size: 11px;
    outline: none;
    padding: 0 8px;

    &:focus {
      border-color: #00f5ff;
      box-shadow: 0 0 12px rgba(0, 245, 255, 0.2);
    }
  }
}

.provider-key-diagnostics {
  display: flex;
  gap: 10px;
  overflow: hidden;
  padding: 0 10px 8px;
  border-bottom: 1px solid #191f27;
  color: #7f8b98;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
  white-space: nowrap;
}

.provider-key-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(88px, auto));
  gap: 6px;
  align-content: end;

  button {
    height: 28px;
    border: 1px solid #333;
    border-radius: 0;
    background: #080808;
    color: #dce5ef;
    font-family: inherit;
    font-size: 10px;
    font-weight: 900;

    &:first-child {
      border-color: rgba(0, 255, 0, 0.45);
      color: #00ff00;
    }

    &:disabled {
      color: #555;
      cursor: wait;
    }
  }
}

.provider-test-table {
  border-bottom: 1px solid #191f27;
}

.provider-key-status {
  overflow: hidden;
  margin: 0;
  padding: 0 10px 10px;
  color: #7f8b98;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 26px;
  padding: 0 10px;
  border-bottom: 1px solid #222;
  background: #080808;
  color: #8794a3;
  font-size: 10px;
  text-transform: uppercase;

  strong {
    color: #f7fbff;
  }
}

.risk-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  border-bottom: 1px solid #222;
}

.risk-cell {
  min-width: 0;
  padding: 10px;
  border-right: 1px solid #222;

  span,
  strong {
    display: block;
  }

  span {
    color: #7f8b98;
    font-size: 10px;
    text-transform: uppercase;
  }

  strong {
    margin-top: 5px;
    font-size: 14px;
    font-weight: 900;
  }
}

.alert-console {
  display: grid;
  border-bottom: 1px solid #222;
}

.action-audit-console {
  display: grid;
  border-bottom: 1px solid #222;
  background: linear-gradient(90deg, rgba(0, 245, 255, 0.06), transparent);
}

.action-audit-line {
  display: grid;
  grid-template-columns: 56px 126px 64px 72px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid rgba(0, 245, 255, 0.12);
  color: #d9e2ee;
  font-size: 10px;

  time {
    color: #7f8b98;
  }

  strong {
    color: #00f5ff;
  }

  span,
  p {
    overflow: hidden;
    margin: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  em {
    color: #00ff00;
    font-style: normal;
  }

  &.rejected em {
    color: #ff003c;
  }
}

.risk-prohibited-console {
  display: grid;
  border-bottom: 1px solid #222;
  background: linear-gradient(90deg, rgba(255, 0, 60, 0.1), transparent);
}

.risk-prohibited-line {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid rgba(255, 0, 60, 0.16);
  color: #d9e2ee;
  font-size: 10px;

  strong {
    color: #ff003c;
    text-shadow: 0 0 10px rgba(255, 0, 60, 0.5);
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.alert-line {
  display: grid;
  grid-template-columns: 56px 72px minmax(120px, 1fr) 96px minmax(0, 1.4fr);
  gap: 10px;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid #151b22;
  color: #d9e2ee;
  font-size: 10px;

  time {
    color: #7f8b98;
  }

  strong {
    color: #ffd700;
  }

  span,
  p {
    overflow: hidden;
    margin: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  em {
    color: #00ff00;
    font-style: normal;
  }
}

.empty-line {
  padding: 18px 10px;
  color: #7f8b98;
  font-size: 11px;
  text-align: center;
}

.trades-panel table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 10px;

  th,
  td {
    overflow: hidden;
    padding: 5px 7px;
    border-bottom: 1px solid #1f1f1f;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  th {
    color: #7f8b98;
    text-transform: uppercase;
  }

  td {
    color: #dce5ef;
  }
}

.truth-console {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  padding: 6px 10px 0;
}

.truth-line {
  min-width: 0;
  border: 1px solid #222;
  padding: 4px 5px;
  background: #050505;
  line-height: 1.2;
  text-transform: uppercase;

  span,
  strong,
  em {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    color: #7f8b98;
    font-size: 8px;
  }

  strong {
    margin-top: 2px;
    font-size: 9px;
  }

  em {
    margin-top: 2px;
    color: #8f9cab;
    font-size: 8px;
    font-style: normal;
    text-transform: none;
  }
}

.provider-console {
  display: flex;
  gap: 4px;
  padding: 5px 10px 0;
  overflow: hidden;

  span {
    min-width: 0;
    border: 1px solid #222;
    padding: 2px 5px;
    background: #050505;
    font-size: 8px;
    line-height: 1.2;
    text-transform: uppercase;
    white-space: nowrap;
  }
}

.analytics-row {
  padding: 6px 10px 0;

  div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: #8f9cab;
    font-size: 10px;
    text-transform: uppercase;
  }

  i {
    display: block;
    height: 7px;
    margin-top: 5px;
    overflow: hidden;
    border: 1px solid #222;
    background: #080808;
  }

  b {
    display: block;
    height: 100%;
    box-shadow: 0 0 12px currentColor;
  }
}

.terminal-actions {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.status-line {
  margin: 7px 10px 0;
  overflow: hidden;
  color: #8f9cab;
  font-size: 10px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.positive,
.tone-up strong {
  color: #00ff00 !important;
}

.negative,
.tone-down strong {
  color: #ff003c !important;
}

.warning,
.tone-warn strong {
  color: #ffd700 !important;
}

.neutral,
.tone-neutral strong {
  color: #dce5ef !important;
}

.positive b,
b.positive {
  background: #00ff00;
  color: #00ff00;
}

.negative b,
b.negative {
  background: #ff003c;
  color: #ff003c;
}

.warning b,
b.warning {
  background: #ffd700;
  color: #ffd700;
}

@media (max-width: 1100px) {
  .terminal-shell {
    overflow: auto;
  }

  .top-row,
  .bottom-row {
    grid-template-columns: 1fr;
    height: auto !important;
  }

  .middle-row {
    flex: 0 0 auto;
    min-height: 460px;
  }

  .row-resizer {
    display: none;
  }

  .terminal-panel {
    min-height: 220px;
  }
}
</style>
