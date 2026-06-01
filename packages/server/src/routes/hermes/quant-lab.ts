import Router from '@koa/router'
import { existsSync, readFileSync } from 'fs'
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, extname, join, resolve } from 'path'
import { getActiveEnvPath } from '../../services/hermes/hermes-profile'
import { saveEnvValue } from '../../services/config-helpers'
import { MIROFISH_SAFE_GATEWAY_ALERT, runMiroFishDebate, type MiroFishDebateEvidencePack, type MiroFishDebateResult } from '../../services/hermes/quant-lab/MiroFishAgent'
import { calculateDynamicWeights, calculateMacroRiskPressure, checkPortfolioExposure, getPortfolioSectorForTicker, synthesizeHermesDecision, type HermesPortfolioPosition, type HermesSynthesizerMiroFishResult } from '../../services/hermes/quant-lab/HermesSynthesizer'
import { applyPessimisticExecution, SLIPPAGE_RATE } from '../../services/hermes/quant-lab/PaperTradingEngine'
import { DEFAULT_AGENT_CREDIBILITY, evaluateTrade, type AgentCredibilityScores, type AgentEvaluationResult, type AgentHistoricalSeed } from '../../services/hermes/quant-lab/AgentEvaluator'
import { listPostMortemReports, retrievePastLessonsForTickers } from '../../services/hermes/quant-lab/MemoryRetriever'
import { TelegramNotifier, type TelegramPremiumQuantAlert } from '../../services/TelegramNotifier'

export const quantLabRoutes = new Router()

type QuantLabTone = 'up' | 'down' | 'warn' | 'neutral'
type QuantLabAction = 'BUY' | 'HOLD' | 'WATCH'
type QuantLabRisk = 'L' | 'M' | 'H'
type QuantLabBriefPhase = 'premarket' | 'afterclose'
type PaperJournalAction = 'BUY' | 'SELL' | 'HOLD' | 'WATCH' | 'MARK' | 'RESET'
type QuantLabDataStatus = 'OK' | 'DEGRADED' | 'FALLBACK' | 'ERROR'
type QuantLabTruthMode = 'real' | 'partial' | 'fallback' | 'mock'
type TerminalActionType = 'DRAW_LINE' | 'CHANGE_TICKER' | 'SIMULATE_TRADE' | 'ADD_JOURNAL' | 'SET_ALERT'
type QuantRiskCheckStatus = 'PASS' | 'WARN' | 'BLOCK'
type QuantNotificationSeverity = 'low' | 'medium' | 'high' | 'critical'
type QuantNotificationKind = 'premarket_brief' | 'afterclose_brief' | 'weekly_summary' | 'risk_guard' | 'terminal_action' | 'paper_trade' | 'data_health' | 'mirofish'
type QuantLabPhaseValidationStatus = 'PASS' | 'FAIL'
type QuantLabPhaseKey = 'phase-1-data' | 'phase-2-selection' | 'phase-3-risk' | 'phase-4-mirofish' | 'phase-5-decision' | 'phase-6-paper' | 'phase-7-memory' | 'phase-8-openclaw' | 'phase-9-telegram' | 'phase-10-agent-eval'

interface QuantLabPhaseValidationCheck {
  key: string
  label: string
  status: QuantLabPhaseValidationStatus
  detail: string
  metadata?: Record<string, unknown>
}

interface QuantLabPhaseValidationResult {
  phase: number
  key: QuantLabPhaseKey
  title: string
  status: QuantLabPhaseValidationStatus
  checks: QuantLabPhaseValidationCheck[]
}

interface QuantRiskCheck {
  key: string
  label: string
  status: QuantRiskCheckStatus
  value: string
  reason: string
  blocksNewBuys?: boolean
}

interface QuantRiskEvaluation {
  status: 'OK' | 'BLOCKED'
  reason: string
  prohibited: string[]
  checks: QuantRiskCheck[]
  generatedAt: string
}

interface QuantNotificationEntry {
  id: string
  createdAt: string
  kind: QuantNotificationKind
  severity: QuantNotificationSeverity
  title: string
  body: string
  dedupeKey: string
  source: string
  status: 'sent' | 'skipped' | 'failed' | 'logged'
  reason?: string
  telegram?: {
    ok: boolean
    chatId?: string
    error?: string
    code?: string
  }
  metadata?: Record<string, unknown>
}

interface QuantNotificationDispatchResult {
  ok: boolean
  sent: boolean
  skipped: boolean
  reason?: string
  entry?: QuantNotificationEntry
  path: string
  relativePath: string
}

type MiroFishEvidenceCategory = 'top10' | 'ticker-news' | 'earnings' | 'macro' | 'world-news' | 'bond' | 'vix' | 'risk' | 'paper' | 'memory' | 'system' | 'topic' | 'context'
type MiroFishInferenceStatus = 'not_run' | 'seed_saved' | 'backend_unavailable' | 'backend_available' | 'submitted' | 'report_ready' | 'error'
type MiroFishConfidence = 'low' | 'medium' | 'high'

interface MiroFishEvidenceItem {
  category: MiroFishEvidenceCategory
  source: string
  title: string
  summary: string
  url?: string
  publishedAt?: string
  tickers?: string[]
  importance: 'low' | 'medium' | 'high'
}

interface MiroFishInference {
  status: MiroFishInferenceStatus
  confidence: MiroFishConfidence
  support: string[]
  oppose: string[]
  neutral: string[]
  debate?: MiroFishDebateResult
  backendUrl?: string
  backendStatus?: string
  projectId?: string
  graphTaskId?: string
  reportPath?: string
  reportRelativePath?: string
  evidenceCount: number
  seedPath?: string
  seedRelativePath?: string
  error?: string
  updatedAt: string
}

interface MiroFishEvidenceArchive {
  path: string
  relativePath: string
  graphOk: boolean
  graphId?: string
  graphSource?: MiroFishGraphSummary['source']
  journalNote: string
  topDegrees: Array<{ ticker: string; degree: number }>
}

interface MiroFishLongTermMemoryRecord {
  fileName: string
  path: string
  relativePath: string
  topic: string
  verdict: string
  date: string
}

interface MiroFishEvidenceArchiveListItem {
  fileName: string
  path: string
  relativePath: string
  title: string
  createdAt: string
  updatedAt: string
  phase?: QuantLabBriefPhase
  status?: string
  confidence?: MiroFishConfidence
  source?: string
  graphOk: boolean
  graphId?: string
  graphSource?: MiroFishGraphSummary['source'] | string
  nodeCount?: number
  edgeCount?: number
  evidenceCount?: number
  topDegrees: Array<{ ticker: string; degree: number }>
  support?: string
  oppose?: string
  summary: string
  size: number
}

interface MiroFishMemoryRecord {
  id: string
  fileName: string
  path: string
  relativePath: string
  title: string
  question: string
  date: string
  finalVerdict: string
  summary: string
  source: string
  tags: string[]
  size: number
  updatedAt: string
}

interface MiroFishGraphTaskStatus {
  ok: boolean
  backendUrl: string
  checkedAt: string
  projectId?: string
  graphTaskId?: string
  graphId?: string
  task?: {
    taskId?: string
    taskType?: string
    status?: string
    progress?: number
    message?: string
    error?: string | null
    result?: Record<string, unknown>
    updatedAt?: string
    createdAt?: string
  }
  project?: {
    projectId?: string
    status?: string
    graphId?: string
    graphBuildTaskId?: string
    name?: string
    updatedAt?: string
    error?: string | null
  }
  error?: string
}

interface MiroFishGraphEdgeSummary {
  source: string
  target: string
  type: string
  fact?: string
}

interface MiroFishGraphSummary {
  ok: boolean
  backendUrl: string
  checkedAt: string
  graphId?: string
  source: 'backend' | 'local-file' | 'none'
  nodeCount: number
  edgeCount: number
  nodeTypes: Array<{ label: string; count: number }>
  edgeTypes: Array<{ label: string; count: number }>
  trackedNodes: Array<{ symbol: string; present: boolean; degree: number; name?: string; labels?: string[]; summary?: string; relatedEdges?: MiroFishGraphEdgeSummary[] }>
  topNodes: Array<{ name: string; degree: number; labels: string[]; summary?: string }>
  sampleEdges: MiroFishGraphEdgeSummary[]
  error?: string
}

interface YahooQuote {
  symbol: string
  shortName?: string
  regularMarketPrice?: number
  regularMarketPreviousClose?: number
  regularMarketChange?: number
  regularMarketChangePercent?: number
  regularMarketVolume?: number
  averageDailyVolume3Month?: number
  marketCap?: number
  fiftyTwoWeekChangePercent?: number
}

interface QuantLabProviderStatus {
  provider: string
  configured: boolean
  status: 'ready' | 'missing-key' | 'ok' | 'partial' | 'failed' | 'skipped'
  detail: string
}

interface QuantLabDataTruthItem {
  area: string
  mode: QuantLabTruthMode
  source: string
  detail: string
}

interface CandidateMeta {
  ticker: string
  baseScore: number
  risk: QuantLabRisk
  reason: string
  fallbackPrice: number
  sector?: string
  theme?: string
  qualityScore?: number
  earningsScore?: number
  liquidityScore?: number
}

interface QuoteBundle {
  source: string
  quotes: Map<string, YahooQuote>
  quoteLatencyMs: number
  providerErrors: string[]
  fallbackUsed: boolean
  delayed: boolean
  receivedAt: string
  providerChain: string[]
  fallbackSymbols: string[]
  providerStatus: QuantLabProviderStatus[]
}

interface PaperPriceBookItem {
  ticker: string
  price: number
  trend: string
  source: string
  quoteSource: string
  updatedAt: string
}

interface HistoricalBar {
  date: string
  close: number
}

interface QuantLabValuationOverlayRow {
  symbol: string
  quantMasterScore: number | null
  quantValueProxy: number | null
  fundamentalLabel: string
  fundamentalValueScore: number | null
  evFcf: string
  baseGap: string
  fundamentalApplicable: boolean
  report: string
  valuationAdjustedMasterScore: number | null
  valuationMasterDelta: string
  valuationAdjustedLabel: string
  valuationAdjustedRank: number | null
  valuationRiskTier: string
  valuationScoreCap: number | null
  valuationMaxAction: QuantLabAction
  valuationWarning: string
  sourceFile: string
  sourceDate: string
}

interface QuantLabSingleStockValuationRow {
  symbol: string
  fundamentalLabel: string
  fundamentalValueScore: number | null
  evFcf: string
  baseGap: string
  report: string
  sourceFile: string
  sourceDate: string
}

interface QuantLabMasterDecisionFeedbackRow {
  symbol: string
  decision: string
  feedbackRank: number | null
  feedbackAdjustedMasterScore: number | null
  wfHealthStatus: string
  wfBenchmark: string
  wfAvgAlphaVsSpy: number | null
  wfAvgOutperformSpyRate: number | null
  wfBenchmarkSampleCount: number | null
  highPrecisionStatus: string
  highPrecisionActionable: boolean
  highPrecisionReason: string
  highConvictionStatus: string
  highConvictionActionable: boolean
  ultraAlertStatus: string
  ultraAlertActionable: boolean
  sourceFile: string
  sourceDate: string
}

interface QuantLabWfRollingPerformance {
  date: string
  generatedAt: string
  policy: string
  snapshotCount: number
  avgReturn5d: number | null
  winRate5d: number | null
  sampleCount5d: number
  spyAvgReturn5d: number | null
  avgAlphaVsSpy5d: number | null
  outperformSpyRate5d: number | null
  outperformSpySampleCount5d: number
  avgReturn10d: number | null
  winRate10d: number | null
  sampleCount10d: number
  spyAvgReturn10d: number | null
  avgAlphaVsSpy10d: number | null
  outperformSpyRate10d: number | null
  outperformSpySampleCount10d: number
  avgReturn20d: number | null
  winRate20d: number | null
  sampleCount20d: number
  spyAvgReturn20d: number | null
  avgAlphaVsSpy20d: number | null
  outperformSpyRate20d: number | null
  outperformSpySampleCount20d: number
  dailySampleCount: number
  dailyAvgReturn: number | null
  dailyWinRate: number | null
  dailyVol: number | null
  dailySharpeProxy: number | null
  dailyAvgAlphaVsSpy: number | null
  dailyOutperformSpyRate: number | null
  dailyOutperformSpySampleCount: number
  avgTurnover: number | null
  latestTurnover: number | null
  latestAdded: string[]
  latestRemoved: string[]
  latestKept: string[]
  sourceFile: string
  sourceDate: string
}

type QuantLabSnapshot = Awaited<ReturnType<typeof buildQuantLabSnapshot>>
type QuantLabCandleTimeframe = '5m' | '15m' | '1h' | '1d'

const QUANT_SNAPSHOT_CACHE_TTL_MS = 15_000
let quantSnapshotCache: { snapshot: QuantLabSnapshot; cachedAt: number } | null = null
let quantSnapshotInFlight: Promise<QuantLabSnapshot> | null = null

async function getCachedQuantLabSnapshot(forceRefresh = false): Promise<{
  snapshot: QuantLabSnapshot
  cachedAt: number
  cacheStatus: 'hit' | 'miss' | 'joined'
}> {
  const now = Date.now()
  if (!forceRefresh && quantSnapshotCache && now - quantSnapshotCache.cachedAt < QUANT_SNAPSHOT_CACHE_TTL_MS) {
    return {
      snapshot: quantSnapshotCache.snapshot,
      cachedAt: quantSnapshotCache.cachedAt,
      cacheStatus: 'hit',
    }
  }

  if (!forceRefresh && quantSnapshotInFlight) {
    const snapshot = await quantSnapshotInFlight
    return {
      snapshot,
      cachedAt: quantSnapshotCache?.cachedAt || Date.now(),
      cacheStatus: 'joined',
    }
  }

  quantSnapshotInFlight = buildQuantLabSnapshot()
  try {
    const snapshot = await quantSnapshotInFlight
    quantSnapshotCache = {
      snapshot,
      cachedAt: Date.now(),
    }
    return {
      snapshot,
      cachedAt: quantSnapshotCache.cachedAt,
      cacheStatus: 'miss',
    }
  } finally {
    quantSnapshotInFlight = null
  }
}

interface QuantLabCandleBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface QuantLabDailySignal {
  ticker: string
  source: string
  bars: number
  price: number
  previousClose: number | null
  changePercent: number | null
  momentum20: number | null
  momentum60: number | null
  ma20: number | null
  ma60: number | null
  ma20DistancePct: number | null
  ma60DistancePct: number | null
  volatility20Pct: number | null
  volumeRatio20: number | null
  consecutiveUpDays: number
}

interface PaperPosition {
  ticker: string
  shares: number
  avgCost: number
  lastPrice: number
  stop: string
  openedAt?: string
  entrySeed?: AgentHistoricalSeed
}

interface PaperJournalEntry {
  time: string
  ticker: string
  action: PaperJournalAction
  note: string
}

interface PaperRiskState {
  tradingDate: string
  dayStartEquity: number
  buysToday: Record<string, string>
  consecutiveLosses: number
  pauseNewBuysUntil?: string
  lastGuardrail?: string
}

interface PaperPostMortemEntry {
  id: string
  ticker: string
  openedAt?: string
  closedAt: string
  result: AgentEvaluationResult['result']
  pnl: number
  pnlPct: number
  shares?: number
  entryPrice?: number
  exitPrice?: number
  markdown: string
  scoreDeltas: {
    quant: number
    bull: number
    bear: number
  }
  updatedCredibility: AgentCredibilityScores
  path?: string
  relativePath?: string
}

interface PaperTradeHistoryEntry {
  id: string
  ticker: string
  result: AgentEvaluationResult['result']
  openedAt: string | null
  closedAt: string
  entryPrice: number | null
  exitPrice: number | null
  shares: number | null
  pnl: number
  pnlPct: number
  holdingSeconds: number | null
  note: string
}

interface PaperEquityCurvePoint {
  time: number
  value: number
}

interface PaperTradeExecutionEvent {
  ticker: string
  side: 'BUY' | 'SELL'
  marketPrice: number
  executionPrice: number
  slippageRate: number
  shares: number
  grossValue: number
  score?: number
  risk?: string
  pnl?: number
  pnlPct?: number
  note: string
  source: string
}

interface PaperAccountState {
  version: 1
  updatedAt: string
  initialCapital: number
  cash: number
  realizedPnl: number
  maxEquity: number
  tradeCount: number
  wins: number
  losses: number
  grossProfit: number
  grossLoss: number
  riskState: PaperRiskState
  agentCredibility: AgentCredibilityScores
  postMortems: PaperPostMortemEntry[]
  positions: PaperPosition[]
  journal: PaperJournalEntry[]
}

type PaperAccountAction = 'BUY' | 'SELL' | 'MARK' | 'RESET' | 'JOURNAL'

const SNAPSHOT = {
  source: 'mock-local',
  marketPulse: [
    { label: 'SPY', value: '+0.42%', tone: 'up' },
    { label: 'QQQ', value: '+0.61%', tone: 'up' },
    { label: 'VIX', value: '14.8 -3.1%', tone: 'down' },
    { label: '10Y', value: '4.31% +0.04', tone: 'warn' },
    { label: 'DXY', value: '104.2 -0.18%', tone: 'down' },
    { label: 'Oil', value: '78.4 +0.7%', tone: 'up' },
    { label: 'Regime', value: 'Risk-on', tone: 'neutral' },
  ],
  topPicks: [
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
  ],
  riskRules: [
    'Max single name: 20%',
    'Max positions: 5',
    'Max daily loss: 2%',
    'Max portfolio drawdown: 10%',
    'No duplicate same-day paper buys',
    '2 consecutive realized losses pause new buys until next session',
    'No leverage / no options',
  ],
  decision: {
    conclusion: '偏多，但不追高。新增部位只允許半倉，半導體仍是主線，10Y 上行是主要壓力。',
    action: 'NVDA / AVGO 可買入候選；MSFT / COST 保留；META / AMD 等待突破確認。',
    invalidation: 'VIX 升破 20、QQQ 跌破 20MA，或 10Y 連三日走高時停止新增買入。',
  },
  chartCaption: [
    'Portfolio beta: 1.06',
    'Market regime: risk-on with 10Y pressure',
    'Signal age: 2 sessions',
  ],
  graphCaption: [
    'Scenario: semis strength spreads into mega-cap tech',
    'Conflict: rising yields cap multiple expansion',
  ],
  backtests: [
    { strategy: 'Quality Momentum 20/60', cagr: '18.4%', sharpe: '1.18', maxDd: '-14.2%', win: '58%', status: 'Active' },
    { strategy: 'Earnings Drift', cagr: '14.1%', sharpe: '0.92', maxDd: '-17.6%', win: '54%', status: 'Watch' },
    { strategy: 'Risk-off Defensive', cagr: '9.6%', sharpe: '0.74', maxDd: '-8.1%', win: '61%', status: 'Hedge' },
  ],
  backtestSummary: [
    'Best fit: risk-on, VIX below 18, QQQ above 50MA',
    'Failure condition: VIX above 22 or 10Y breaks higher for 3 sessions',
  ],
  dataHealth: {
    quoteSource: 'mock-local',
    quoteCoverage: '0/0',
    missingSymbols: [] as string[],
    backtestSource: 'mock-local',
    updatedAt: new Date(0).toISOString(),
  },
  priceBook: [] as PaperPriceBookItem[],
  dailySignals: [] as QuantLabDailySignal[],
}

const MARKET_SYMBOLS = ['SPY', 'QQQ', '^VIX', '^TNX', 'DX-Y.NYB', 'CL=F']
const ACCEPTED_MACRO_FALLBACK_SYMBOLS = new Set(MARKET_SYMBOLS)
const YAHOO_DAILY_MACRO_FALLBACK_SYMBOLS = new Set(['DX-Y.NYB', 'CL=F'])
const YAHOO_SCREENER_IDS = ['most_actives', 'day_gainers', 'day_losers'] as const
const YAHOO_SCREENER_COUNT = 100
const YAHOO_SCREENER_CACHE_TTL_MS = 8 * 60 * 1000
let yahooScreenerCandidateCache: { expiresAt: number; candidates: CandidateMeta[]; detail: string } | null = null

function candidate(
  ticker: string,
  baseScore: number,
  risk: QuantLabRisk,
  reason: string,
  fallbackPrice: number,
  sector: string,
  theme: string,
  qualityScore = 0,
  earningsScore = 0,
  liquidityScore = 0
): CandidateMeta {
  return { ticker, baseScore, risk, reason, fallbackPrice, sector, theme, qualityScore, earningsScore, liquidityScore }
}

const CANDIDATE_UNIVERSE: CandidateMeta[] = [
  candidate('NVDA', 90, 'M', 'AI demand / accelerator leadership / datacenter capex', 215.34, 'Technology', 'AI semis', 9, 9, 10),
  candidate('MSFT', 88, 'L', 'quality compounder / cloud cash flow / AI platform', 418.57, 'Technology', 'Cloud AI', 10, 8, 10),
  candidate('AVGO', 86, 'M', 'semis flow / earnings strength / AI networking', 414.14, 'Technology', 'AI semis', 8, 9, 9),
  candidate('GOOGL', 85, 'M', 'ad cycle recovery / AI optionality / cloud leverage', 382.97, 'Communication Services', 'AI ads', 8, 7, 10),
  candidate('META', 84, 'M', 'margin expansion / buyback support / AI engagement', 728.4, 'Communication Services', 'AI ads', 8, 8, 10),
  candidate('COST', 83, 'L', 'defensive growth / high quality / membership renewal', 1028.24, 'Consumer Staples', 'Defensive compounder', 9, 7, 8),
  candidate('LLY', 82, 'M', 'GLP-1 leadership / pricing power / drug pipeline', 1065, 'Health Care', 'GLP-1', 8, 8, 8),
  candidate('AMD', 81, 'H', 'AI accelerator beta / breakout pending / high beta chips', 467.51, 'Technology', 'AI semis', 6, 7, 9),
  candidate('JPM', 80, 'L', 'balance sheet quality / rate sensitivity / credit cycle', 288.6, 'Financials', 'Quality financials', 8, 6, 9),
  candidate('AMZN', 80, 'M', 'cloud acceleration / operating leverage / retail margin', 224.35, 'Consumer Discretionary', 'Cloud commerce', 8, 7, 10),
  candidate('AAPL', 79, 'L', 'services durability / capital return / device cycle', 308.82, 'Technology', 'Mega-cap quality', 9, 6, 10),
  candidate('V', 78, 'L', 'payment network quality / global spend / margin durability', 284.62, 'Financials', 'Payments', 9, 7, 8),
  candidate('MA', 78, 'L', 'payment network quality / cross-border volume / pricing power', 456.1, 'Financials', 'Payments', 9, 7, 8),
  candidate('BRK-B', 78, 'L', 'Buffett-style quality / cash optionality / insurance float', 415.12, 'Financials', 'Quality value', 10, 6, 8),
  candidate('TSLA', 76, 'H', 'high beta sentiment / execution risk / autonomous optionality', 426.01, 'Consumer Discretionary', 'High beta growth', 5, 5, 10),
  candidate('UNH', 75, 'M', 'defensive healthcare / policy overhang / managed care reset', 388.47, 'Health Care', 'Defensive healthcare', 7, 5, 8),
  candidate('ORCL', 78, 'M', 'database cash flow / cloud backlog / AI infrastructure', 169.7, 'Technology', 'Cloud AI', 7, 8, 8),
  candidate('CRM', 77, 'M', 'enterprise software margin / AI automation / buyback', 286.4, 'Technology', 'Enterprise software', 7, 6, 8),
  candidate('NOW', 77, 'M', 'workflow platform / enterprise AI / high quality growth', 756.25, 'Technology', 'Enterprise software', 8, 7, 7),
  candidate('ADBE', 76, 'M', 'creative software / AI monetization / recurring revenue', 475.2, 'Technology', 'Enterprise software', 8, 5, 8),
  candidate('PANW', 77, 'M', 'cybersecurity platform / billings recovery / cloud security', 332.4, 'Technology', 'Cybersecurity', 7, 6, 8),
  candidate('CRWD', 76, 'H', 'endpoint security growth / high multiple / momentum sensitive', 321.8, 'Technology', 'Cybersecurity', 6, 7, 8),
  candidate('PLTR', 76, 'H', 'AI software demand / government-commercial mix / high beta', 126.5, 'Technology', 'AI software', 5, 7, 10),
  candidate('SNOW', 72, 'H', 'data cloud reset / AI data workload / execution watch', 168.3, 'Technology', 'Data cloud', 5, 4, 7),
  candidate('NET', 72, 'H', 'edge network / security growth / valuation sensitive', 108.2, 'Technology', 'Cloud security', 5, 5, 7),
  candidate('DDOG', 72, 'H', 'observability demand / cloud optimization cycle / high beta', 124.4, 'Technology', 'Cloud software', 5, 5, 7),
  candidate('QCOM', 76, 'M', 'handset recovery / edge AI / automotive pipeline', 186.5, 'Technology', 'Semis', 7, 6, 8),
  candidate('TXN', 74, 'M', 'analog cycle recovery / industrial demand / capital intensity', 203.1, 'Technology', 'Semis', 7, 5, 7),
  candidate('AMAT', 76, 'M', 'semi equipment / wafer fab capex / AI supply chain', 214.5, 'Technology', 'Semi equipment', 7, 7, 8),
  candidate('LRCX', 75, 'M', 'memory equipment recovery / wafer fab spending / AI supply chain', 96.8, 'Technology', 'Semi equipment', 7, 6, 7),
  candidate('MU', 74, 'H', 'memory cycle / HBM demand / earnings volatility', 141.2, 'Technology', 'Memory semis', 5, 8, 9),
  candidate('INTC', 67, 'H', 'turnaround optionality / foundry execution / high uncertainty', 34.1, 'Technology', 'Turnaround semis', 4, 3, 9),
  candidate('IBM', 73, 'L', 'hybrid cloud / consulting cash flow / defensive tech', 184.9, 'Technology', 'Defensive tech', 7, 5, 7),
  candidate('CSCO', 72, 'L', 'networking cash flow / security mix / low beta tech', 52.3, 'Technology', 'Defensive tech', 7, 4, 8),
  candidate('WMT', 78, 'L', 'defensive retail / grocery share / scale logistics', 66.1, 'Consumer Staples', 'Defensive compounder', 8, 7, 9),
  candidate('HD', 76, 'L', 'housing repair cycle / high quality retail / rates sensitivity', 358.5, 'Consumer Discretionary', 'Housing cycle', 8, 5, 8),
  candidate('MCD', 75, 'L', 'franchise cash flow / pricing power / defensive consumer', 286.3, 'Consumer Discretionary', 'Defensive consumer', 8, 5, 8),
  candidate('SBUX', 69, 'M', 'traffic recovery / China sensitivity / margin reset', 82.4, 'Consumer Discretionary', 'Consumer recovery', 5, 3, 8),
  candidate('BKNG', 76, 'M', 'travel demand / high margin marketplace / buyback', 3822.0, 'Consumer Discretionary', 'Travel', 8, 7, 7),
  candidate('NFLX', 77, 'M', 'streaming scale / ad tier / margin expansion', 680.3, 'Communication Services', 'Streaming', 8, 7, 9),
  candidate('DIS', 69, 'M', 'media turnaround / parks cash flow / streaming profitability', 103.7, 'Communication Services', 'Turnaround media', 5, 4, 9),
  candidate('UBER', 75, 'M', 'mobility scale / delivery margins / operating leverage', 71.9, 'Industrials', 'Platform growth', 6, 7, 9),
  candidate('PFE', 66, 'M', 'post-COVID reset / pipeline watch / value trap risk', 28.2, 'Health Care', 'Pharma reset', 5, 3, 9),
  candidate('MRK', 75, 'L', 'pharma quality / oncology franchise / pipeline durability', 124.5, 'Health Care', 'Defensive healthcare', 8, 6, 8),
  candidate('ABBV', 75, 'L', 'immunology transition / dividend quality / pipeline', 170.2, 'Health Care', 'Defensive healthcare', 8, 5, 8),
  candidate('TMO', 74, 'M', 'life science tools recovery / margin quality / pharma capex', 588.4, 'Health Care', 'Life science tools', 8, 5, 7),
  candidate('ISRG', 76, 'M', 'robotic surgery adoption / procedure growth / premium multiple', 426.7, 'Health Care', 'Medtech growth', 8, 7, 7),
  candidate('DHR', 73, 'M', 'life science tools / bioprocess recovery / quality compounder', 257.9, 'Health Care', 'Life science tools', 8, 4, 7),
  candidate('ABT', 72, 'L', 'medtech stability / diagnostics normalization / defensive growth', 112.4, 'Health Care', 'Medtech defensive', 7, 4, 7),
  candidate('JNJ', 72, 'L', 'defensive healthcare / litigation overhang / dividend quality', 152.5, 'Health Care', 'Defensive healthcare', 8, 3, 8),
  candidate('REGN', 73, 'M', 'biotech quality / pipeline optionality / earnings durability', 978.2, 'Health Care', 'Biotech quality', 7, 5, 6),
  candidate('AMGN', 72, 'M', 'large biotech cash flow / obesity optionality / debt watch', 306.4, 'Health Care', 'Biotech quality', 7, 4, 7),
  candidate('XOM', 72, 'M', 'energy cash flow / oil beta / dividend discipline', 117.8, 'Energy', 'Energy cash flow', 7, 5, 9),
  candidate('CVX', 71, 'M', 'integrated energy / capital discipline / oil beta', 158.1, 'Energy', 'Energy cash flow', 7, 4, 8),
  candidate('COP', 71, 'M', 'upstream oil leverage / capital returns / commodity beta', 113.9, 'Energy', 'Energy cash flow', 6, 5, 8),
  candidate('SLB', 70, 'M', 'oil services cycle / international spending / commodity sensitivity', 46.8, 'Energy', 'Oil services', 5, 5, 8),
  candidate('CAT', 74, 'M', 'industrial cycle / infrastructure spend / commodity leverage', 335.6, 'Industrials', 'Industrial cycle', 7, 6, 8),
  candidate('DE', 73, 'M', 'ag cycle / equipment margins / rate sensitivity', 412.7, 'Industrials', 'Industrial cycle', 7, 4, 7),
  candidate('GE', 75, 'M', 'aerospace backlog / margin expansion / industrial quality', 167.5, 'Industrials', 'Aerospace industrials', 7, 7, 8),
  candidate('ETN', 76, 'M', 'electrification demand / data center power / margin quality', 312.9, 'Industrials', 'Power infrastructure', 8, 7, 8),
  candidate('HON', 72, 'L', 'industrial quality / aerospace automation / defensive cash flow', 202.2, 'Industrials', 'Industrial quality', 7, 4, 7),
  candidate('UNP', 72, 'L', 'rail pricing power / freight cycle / operating ratio', 244.5, 'Industrials', 'Transport quality', 7, 4, 7),
  candidate('UPS', 68, 'M', 'parcel cycle reset / labor cost digestion / yield watch', 148.6, 'Industrials', 'Transport reset', 5, 3, 8),
  candidate('AXP', 74, 'M', 'premium consumer spend / credit cycle / network quality', 242.8, 'Financials', 'Payments', 7, 6, 8),
  candidate('BAC', 69, 'M', 'deposit beta / rate curve sensitivity / credit watch', 38.4, 'Financials', 'Banks', 5, 4, 9),
  candidate('GS', 73, 'M', 'capital markets recovery / investment banking cycle', 468.2, 'Financials', 'Capital markets', 7, 5, 7),
  candidate('MS', 73, 'M', 'wealth management quality / capital markets recovery', 101.2, 'Financials', 'Capital markets', 7, 5, 8),
  candidate('BLK', 74, 'L', 'asset management scale / ETF flows / market beta', 812.4, 'Financials', 'Asset management', 8, 5, 7),
  candidate('COIN', 68, 'H', 'crypto beta / volume cycle / regulatory risk', 226.6, 'Financials', 'Crypto beta', 3, 6, 8),
  candidate('SHOP', 72, 'H', 'commerce platform / margin discipline / high multiple', 69.8, 'Technology', 'Commerce software', 5, 6, 8),
  candidate('MELI', 74, 'H', 'Latin America commerce / fintech growth / FX risk', 1605.2, 'Consumer Discretionary', 'International growth', 7, 7, 6),
  candidate('TSM', 78, 'M', 'foundry leadership / AI supply chain / geopolitical risk', 184.2, 'Technology', 'AI semis', 8, 8, 8),
  candidate('ASML', 78, 'M', 'lithography monopoly / leading-edge fab capex / China controls', 982.4, 'Technology', 'Semi equipment', 9, 7, 7),
  candidate('ARM', 74, 'H', 'AI edge architecture / royalty growth / valuation sensitive', 122.5, 'Technology', 'AI semis', 6, 7, 8),
  candidate('KLAC', 76, 'M', 'process control quality / wafer fab intensity / margin durability', 744.1, 'Technology', 'Semi equipment', 8, 7, 7),
  candidate('MRVL', 74, 'H', 'AI networking beta / custom silicon / execution volatility', 71.4, 'Technology', 'AI semis', 5, 7, 8),
  candidate('ADI', 73, 'M', 'analog quality / industrial cycle recovery / margin durability', 224.3, 'Technology', 'Semis', 8, 5, 7),
  candidate('ON', 69, 'H', 'auto semis reset / silicon carbide / cyclical pressure', 72.2, 'Technology', 'Auto semis', 5, 4, 7),
  candidate('MPWR', 74, 'H', 'power management quality / AI power density / premium multiple', 732.4, 'Technology', 'Power semis', 7, 7, 6),
  candidate('MCHP', 69, 'M', 'microcontroller cycle reset / industrial demand / inventory digestion', 88.5, 'Technology', 'Semis', 6, 3, 7),
  candidate('CDNS', 76, 'M', 'EDA design moat / AI chip design demand / recurring revenue', 295.6, 'Technology', 'EDA software', 9, 7, 7),
  candidate('SNPS', 76, 'M', 'EDA software moat / chip complexity / recurring revenue', 551.2, 'Technology', 'EDA software', 9, 7, 7),
  candidate('ANET', 76, 'M', 'AI datacenter networking / cloud capex / margin quality', 91.8, 'Technology', 'AI networking', 7, 8, 8),
  candidate('DELL', 72, 'H', 'AI server demand / margin mix / hardware cycle beta', 126.4, 'Technology', 'AI infrastructure', 5, 7, 8),
  candidate('HPE', 68, 'M', 'enterprise hardware / AI server optionality / lower margin', 20.7, 'Technology', 'AI infrastructure', 4, 4, 8),
  candidate('APP', 74, 'H', 'adtech AI optimization / high growth / high multiple risk', 84.5, 'Technology', 'AI ads', 5, 8, 8),
  candidate('TEAM', 72, 'H', 'collaboration software / cloud migration / enterprise seat growth', 188.4, 'Technology', 'Enterprise software', 6, 5, 7),
  candidate('MDB', 70, 'H', 'developer database / AI app workload / consumption volatility', 286.5, 'Technology', 'Data cloud', 5, 4, 7),
  candidate('ZS', 72, 'H', 'zero trust security / billings recovery / valuation sensitive', 184.8, 'Technology', 'Cybersecurity', 6, 5, 7),
  candidate('OKTA', 68, 'H', 'identity security reset / enterprise spend / execution watch', 92.7, 'Technology', 'Cybersecurity', 4, 3, 7),
  candidate('FTNT', 72, 'M', 'network security cash flow / firewall refresh / margin quality', 68.3, 'Technology', 'Cybersecurity', 7, 5, 8),
  candidate('TTD', 73, 'H', 'programmatic ads / CTV growth / ad cycle beta', 93.6, 'Communication Services', 'AI ads', 6, 6, 8),
  candidate('INTU', 76, 'M', 'tax and SMB software / pricing power / AI workflow', 642.2, 'Technology', 'Enterprise software', 9, 7, 7),
  candidate('ADSK', 71, 'M', 'design software / construction digitization / margin watch', 248.7, 'Technology', 'Enterprise software', 7, 4, 7),
  candidate('PYPL', 68, 'M', 'payments turnaround / margin repair / competitive pressure', 65.8, 'Financials', 'Payments reset', 5, 4, 9),
  candidate('RBLX', 68, 'H', 'gaming engagement / ad monetization / youth platform risk', 36.5, 'Communication Services', 'Gaming platform', 4, 5, 7),
  candidate('EA', 70, 'L', 'game franchise cash flow / live services / release cycle', 142.3, 'Communication Services', 'Gaming', 7, 4, 6),
  candidate('TTWO', 70, 'M', 'game release catalyst / GTA cycle / execution risk', 163.8, 'Communication Services', 'Gaming', 6, 5, 6),
  candidate('TMUS', 74, 'L', 'wireless share gains / buyback / defensive growth', 178.2, 'Communication Services', 'Telecom quality', 8, 6, 8),
  candidate('T', 65, 'L', 'telecom dividend / debt load / low growth', 18.4, 'Communication Services', 'Telecom defensive', 5, 3, 9),
  candidate('VZ', 65, 'L', 'telecom dividend / low beta / debt sensitivity', 41.2, 'Communication Services', 'Telecom defensive', 5, 3, 8),
  candidate('CMCSA', 66, 'L', 'cable cash flow / broadband pressure / media reset', 39.8, 'Communication Services', 'Defensive media', 6, 3, 8),
  candidate('PEP', 74, 'L', 'snacks and beverages / pricing power / defensive compounder', 176.4, 'Consumer Staples', 'Defensive compounder', 8, 5, 8),
  candidate('KO', 74, 'L', 'beverage quality / global brand / defensive cash flow', 63.8, 'Consumer Staples', 'Defensive compounder', 8, 5, 9),
  candidate('PG', 75, 'L', 'staples quality / pricing power / low beta', 166.2, 'Consumer Staples', 'Defensive compounder', 9, 5, 8),
  candidate('CL', 72, 'L', 'household staples / emerging market mix / pricing power', 94.3, 'Consumer Staples', 'Defensive compounder', 8, 4, 7),
  candidate('MDLZ', 72, 'L', 'global snacks / pricing power / defensive growth', 68.7, 'Consumer Staples', 'Defensive compounder', 7, 5, 8),
  candidate('PM', 71, 'L', 'smokeless transition / dividend / regulatory risk', 101.4, 'Consumer Staples', 'Defensive income', 7, 5, 7),
  candidate('TGT', 67, 'M', 'retail turnaround / discretionary pressure / margin repair', 154.6, 'Consumer Staples', 'Retail reset', 5, 3, 8),
  candidate('LOW', 74, 'L', 'home improvement quality / housing cycle / rates sensitivity', 236.5, 'Consumer Discretionary', 'Housing cycle', 8, 5, 8),
  candidate('TJX', 74, 'L', 'off-price retail quality / value consumer / margin durability', 101.7, 'Consumer Discretionary', 'Defensive consumer', 8, 6, 7),
  candidate('NKE', 66, 'M', 'brand reset / China demand / margin pressure', 92.4, 'Consumer Discretionary', 'Consumer reset', 5, 3, 9),
  candidate('CMG', 73, 'M', 'restaurant growth / pricing power / premium multiple', 57.8, 'Consumer Discretionary', 'Restaurant growth', 8, 6, 8),
  candidate('LULU', 69, 'M', 'athletic apparel quality / demand reset / valuation compression', 312.5, 'Consumer Discretionary', 'Consumer reset', 6, 3, 7),
  candidate('ROST', 72, 'L', 'off-price retail / defensive consumer / margin recovery', 146.2, 'Consumer Discretionary', 'Defensive consumer', 7, 5, 7),
  candidate('MAR', 73, 'M', 'hotel asset-light model / travel demand / buyback', 248.9, 'Consumer Discretionary', 'Travel', 8, 6, 7),
  candidate('ABNB', 68, 'H', 'travel marketplace / regulatory risk / growth normalization', 151.2, 'Consumer Discretionary', 'Travel platform', 5, 4, 8),
  candidate('RCL', 70, 'H', 'cruise demand / balance sheet repair / consumer beta', 154.4, 'Consumer Discretionary', 'Travel beta', 4, 6, 8),
  candidate('GM', 65, 'M', 'auto cycle / buyback / EV transition risk', 46.8, 'Consumer Discretionary', 'Auto value', 5, 4, 9),
  candidate('F', 63, 'M', 'auto cycle / dividend / EV losses', 12.4, 'Consumer Discretionary', 'Auto value', 4, 3, 10),
  candidate('ELV', 73, 'M', 'managed care quality / policy risk / healthcare demand', 522.7, 'Health Care', 'Managed care', 7, 5, 7),
  candidate('CI', 72, 'M', 'managed care cash flow / pharmacy benefits / policy watch', 342.8, 'Health Care', 'Managed care', 7, 5, 7),
  candidate('HUM', 65, 'H', 'medicare advantage reset / margin pressure / policy risk', 371.2, 'Health Care', 'Managed care reset', 4, 2, 7),
  candidate('CVS', 65, 'M', 'healthcare retail reset / Aetna pressure / dividend watch', 58.4, 'Health Care', 'Healthcare reset', 4, 2, 8),
  candidate('GILD', 70, 'L', 'biotech cash flow / HIV franchise / pipeline optionality', 73.6, 'Health Care', 'Biotech quality', 7, 4, 7),
  candidate('BMY', 66, 'M', 'patent cliff reset / pipeline risk / value setup', 48.7, 'Health Care', 'Pharma reset', 5, 2, 8),
  candidate('MDT', 70, 'L', 'medtech recovery / dividend / low beta healthcare', 84.8, 'Health Care', 'Medtech defensive', 7, 4, 7),
  candidate('SYK', 74, 'M', 'orthopedics growth / medtech quality / premium multiple', 338.1, 'Health Care', 'Medtech growth', 8, 6, 7),
  candidate('BSX', 73, 'M', 'medtech growth / procedure volume / margin expansion', 74.3, 'Health Care', 'Medtech growth', 7, 6, 7),
  candidate('VRTX', 75, 'M', 'biotech quality / cystic fibrosis moat / pipeline optionality', 443.9, 'Health Care', 'Biotech quality', 8, 6, 6),
  candidate('MRNA', 62, 'H', 'pipeline optionality / cash burn / biotech volatility', 112.6, 'Health Care', 'Biotech high beta', 3, 2, 8),
  candidate('WFC', 68, 'M', 'bank turnaround / rate sensitivity / regulatory cap', 59.2, 'Financials', 'Banks', 5, 4, 9),
  candidate('C', 66, 'M', 'bank restructuring / capital return / execution risk', 62.7, 'Financials', 'Banks', 4, 3, 9),
  candidate('SCHW', 71, 'M', 'brokerage scale / cash sorting sensitivity / market beta', 75.4, 'Financials', 'Brokerage', 7, 4, 8),
  candidate('SPGI', 76, 'L', 'ratings moat / index data / capital markets beta', 448.2, 'Financials', 'Market data', 9, 6, 7),
  candidate('MCO', 75, 'L', 'ratings moat / analytics / capital markets cycle', 398.4, 'Financials', 'Market data', 9, 6, 6),
  candidate('CME', 73, 'L', 'exchange quality / volatility beneficiary / high margin', 216.8, 'Financials', 'Exchanges', 8, 5, 7),
  candidate('ICE', 73, 'L', 'exchange and data quality / mortgage tech reset / high margin', 139.5, 'Financials', 'Exchanges', 8, 5, 7),
  candidate('PGR', 74, 'L', 'insurance underwriting quality / pricing cycle / defensive growth', 205.6, 'Financials', 'Insurance quality', 8, 6, 7),
  candidate('CB', 74, 'L', 'commercial insurance quality / pricing power / defensive financial', 252.3, 'Financials', 'Insurance quality', 8, 5, 6),
  candidate('BA', 63, 'H', 'aerospace turnaround / delivery risk / balance sheet pressure', 183.7, 'Industrials', 'Aerospace reset', 3, 2, 9),
  candidate('RTX', 70, 'M', 'defense aerospace / engine issue recovery / backlog', 104.6, 'Industrials', 'Defense aerospace', 6, 4, 8),
  candidate('LMT', 72, 'L', 'defense cash flow / geopolitical demand / low beta', 468.1, 'Industrials', 'Defense', 8, 4, 7),
  candidate('NOC', 71, 'L', 'defense backlog / space systems / margin watch', 466.8, 'Industrials', 'Defense', 7, 4, 6),
  candidate('GD', 72, 'L', 'defense and aerospace / submarine backlog / cash flow', 294.7, 'Industrials', 'Defense', 7, 4, 6),
  candidate('PH', 75, 'M', 'industrial quality / aerospace and motion control / margin durability', 548.2, 'Industrials', 'Industrial quality', 8, 6, 7),
  candidate('EMR', 71, 'M', 'automation cycle / process control / industrial quality', 113.4, 'Industrials', 'Automation', 7, 4, 7),
  candidate('MMM', 64, 'M', 'industrial turnaround / litigation reset / margin repair', 101.5, 'Industrials', 'Turnaround industrials', 4, 3, 8),
  candidate('CARR', 72, 'M', 'HVAC demand / building efficiency / margin expansion', 66.4, 'Industrials', 'Building systems', 7, 5, 7),
  candidate('TT', 75, 'M', 'HVAC quality / efficiency demand / industrial compounder', 318.5, 'Industrials', 'Building systems', 8, 6, 7),
  candidate('ROK', 70, 'M', 'factory automation cycle / industrial recovery / order watch', 274.6, 'Industrials', 'Automation', 7, 3, 6),
  candidate('FAST', 72, 'L', 'industrial distribution / margin quality / activity gauge', 67.5, 'Industrials', 'Industrial quality', 7, 4, 7),
  candidate('EOG', 71, 'M', 'shale quality / capital discipline / oil beta', 128.4, 'Energy', 'Energy cash flow', 7, 4, 7),
  candidate('OXY', 68, 'H', 'oil beta / balance sheet leverage / Buffett ownership signal', 62.3, 'Energy', 'Energy beta', 4, 5, 8),
  candidate('LNG', 72, 'M', 'LNG export demand / long-term contracts / energy infrastructure', 164.7, 'Energy', 'Energy infrastructure', 7, 5, 6),
  candidate('HAL', 67, 'M', 'oil services cycle / North America exposure / commodity beta', 35.8, 'Energy', 'Oil services', 4, 4, 8),
  candidate('MPC', 70, 'M', 'refining margins / capital returns / crack spread beta', 178.6, 'Energy', 'Refining', 6, 5, 8),
  candidate('VLO', 69, 'M', 'refining margins / commodity spread beta / shareholder returns', 154.2, 'Energy', 'Refining', 6, 4, 8),
  candidate('FCX', 70, 'H', 'copper leverage / electrification demand / China macro beta', 48.2, 'Materials', 'Copper electrification', 5, 5, 8),
  candidate('NEM', 66, 'M', 'gold miner leverage / real rates hedge / execution watch', 42.6, 'Materials', 'Gold hedge', 4, 3, 8),
  candidate('LIN', 76, 'L', 'industrial gas quality / pricing power / defensive industrial', 452.4, 'Materials', 'Industrial gas', 9, 6, 7),
  candidate('APD', 69, 'M', 'industrial gas / hydrogen projects / execution risk', 261.5, 'Materials', 'Industrial gas', 6, 3, 6),
  candidate('SHW', 73, 'L', 'coatings quality / housing repair cycle / pricing power', 316.2, 'Materials', 'Housing cycle', 8, 5, 6),
  candidate('NEE', 68, 'L', 'renewables utility / rate sensitivity / defensive yield', 72.8, 'Utilities', 'Clean power', 6, 4, 8),
  candidate('SO', 67, 'L', 'regulated utility / dividend / rate sensitivity', 78.4, 'Utilities', 'Defensive utility', 6, 3, 8),
  candidate('DUK', 67, 'L', 'regulated utility / dividend / low beta', 102.2, 'Utilities', 'Defensive utility', 6, 3, 8),
  candidate('AEP', 66, 'L', 'regulated utility / grid investment / rate sensitivity', 91.6, 'Utilities', 'Defensive utility', 6, 3, 7),
  candidate('CEG', 72, 'M', 'nuclear power demand / datacenter electricity / policy support', 198.7, 'Utilities', 'Power infrastructure', 6, 7, 7),
  candidate('VST', 70, 'H', 'power price beta / datacenter demand / high volatility', 91.5, 'Utilities', 'Power infrastructure', 4, 7, 8),
  candidate('PLD', 69, 'M', 'logistics real estate / rate sensitivity / occupancy quality', 118.4, 'Real Estate', 'Industrial REIT', 7, 3, 7),
  candidate('AMT', 67, 'M', 'tower cash flow / rate sensitivity / telecom capex', 194.6, 'Real Estate', 'Tower REIT', 7, 3, 7),
  candidate('EQIX', 74, 'M', 'datacenter REIT / AI colocation demand / rate sensitivity', 782.4, 'Real Estate', 'AI infrastructure', 8, 6, 6),
]

const BROAD_US_STOCK_GROUPS: Array<{
  sector: string
  theme: string
  risk: QuantLabRisk
  baseScore: number
  qualityScore: number
  earningsScore: number
  liquidityScore: number
  symbols: string[]
}> = [
  {
    sector: 'Technology',
    theme: 'Software and infrastructure',
    risk: 'M',
    baseScore: 73,
    qualityScore: 7,
    earningsScore: 5,
    liquidityScore: 7,
    symbols: ['ACN', 'ADP', 'PAYX', 'ROP', 'FICO', 'MSI', 'APH', 'TEL', 'GLW', 'KEYS', 'GDDY', 'WDAY', 'HUBS', 'DOCU', 'TWLO'],
  },
  {
    sector: 'Technology',
    theme: 'Semis and hardware breadth',
    risk: 'H',
    baseScore: 72,
    qualityScore: 6,
    earningsScore: 6,
    liquidityScore: 8,
    symbols: ['NXPI', 'SWKS', 'QRVO', 'TER', 'ENTG', 'WDC', 'STX', 'GFS', 'SMCI', 'CLS', 'COHR', 'OLED', 'WOLF', 'AEIS', 'VRT'],
  },
  {
    sector: 'Financials',
    theme: 'Banks, brokers, insurers',
    risk: 'M',
    baseScore: 71,
    qualityScore: 6,
    earningsScore: 4,
    liquidityScore: 8,
    symbols: ['BK', 'USB', 'TFC', 'PNC', 'COF', 'ALL', 'AIG', 'TRV', 'AFL', 'MET', 'PRU', 'MMC', 'AON', 'AJG', 'AMP', 'TROW', 'NDAQ', 'CBOE', 'RJF', 'FITB', 'MTB', 'HBAN', 'KEY'],
  },
  {
    sector: 'Health Care',
    theme: 'Healthcare breadth',
    risk: 'M',
    baseScore: 72,
    qualityScore: 7,
    earningsScore: 5,
    liquidityScore: 7,
    symbols: ['ZTS', 'EW', 'BDX', 'HCA', 'UHS', 'THC', 'DGX', 'LH', 'CNC', 'MOH', 'BIIB', 'ILMN', 'ALNY', 'INCY', 'WAT', 'HOLX', 'IDXX', 'RMD', 'PODD', 'COO'],
  },
  {
    sector: 'Industrials',
    theme: 'Industrial, transport, logistics',
    risk: 'M',
    baseScore: 72,
    qualityScore: 7,
    earningsScore: 5,
    liquidityScore: 7,
    symbols: ['WM', 'RSG', 'URI', 'PCAR', 'CMI', 'ITW', 'DOV', 'IR', 'XYL', 'PWR', 'JCI', 'DAL', 'UAL', 'LUV', 'FDX', 'CSX', 'NSC', 'ODFL', 'EXPD', 'TXT', 'LHX'],
  },
  {
    sector: 'Consumer Discretionary',
    theme: 'Consumer cyclicals and travel',
    risk: 'M',
    baseScore: 71,
    qualityScore: 6,
    earningsScore: 5,
    liquidityScore: 7,
    symbols: ['ORLY', 'AZO', 'DRI', 'YUM', 'DPZ', 'QSR', 'GPC', 'BBY', 'DG', 'DLTR', 'KMX', 'LEN', 'DHI', 'PHM', 'TOL', 'NVR', 'WYNN', 'LVS', 'MGM', 'CCL', 'HLT', 'H', 'EXPE'],
  },
  {
    sector: 'Consumer Staples',
    theme: 'Defensive consumer breadth',
    risk: 'L',
    baseScore: 72,
    qualityScore: 7,
    earningsScore: 4,
    liquidityScore: 7,
    symbols: ['KR', 'KMB', 'GIS', 'K', 'HSY', 'SJM', 'CPB', 'CAG', 'KHC', 'EL', 'STZ', 'TAP', 'ADM', 'TSN', 'MKC', 'CHD', 'SYY'],
  },
  {
    sector: 'Energy',
    theme: 'Energy and infrastructure',
    risk: 'M',
    baseScore: 70,
    qualityScore: 6,
    earningsScore: 5,
    liquidityScore: 8,
    symbols: ['WMB', 'KMI', 'TRGP', 'PSX', 'FANG', 'DVN', 'BKR', 'NOV', 'HWM', 'OKE', 'EQT', 'CTRA', 'APA'],
  },
  {
    sector: 'Materials',
    theme: 'Materials and commodities',
    risk: 'M',
    baseScore: 70,
    qualityScore: 6,
    earningsScore: 4,
    liquidityScore: 7,
    symbols: ['ALB', 'ECL', 'DD', 'DOW', 'NUE', 'STLD', 'AA', 'SCCO', 'MOS', 'CF', 'CTVA', 'MLM', 'VMC', 'PKG', 'BALL'],
  },
  {
    sector: 'Utilities',
    theme: 'Utilities and power',
    risk: 'L',
    baseScore: 69,
    qualityScore: 6,
    earningsScore: 4,
    liquidityScore: 7,
    symbols: ['SRE', 'EXC', 'XEL', 'D', 'PEG', 'EIX', 'ED', 'WEC', 'DTE', 'PPL', 'AWK', 'FE', 'AES'],
  },
  {
    sector: 'Real Estate',
    theme: 'REIT breadth',
    risk: 'M',
    baseScore: 69,
    qualityScore: 6,
    earningsScore: 3,
    liquidityScore: 7,
    symbols: ['O', 'WELL', 'PSA', 'SPG', 'CCI', 'DLR', 'VICI', 'EQR', 'AVB', 'ELS', 'IRM', 'ARE', 'BXP'],
  },
  {
    sector: 'Communication Services',
    theme: 'Media, entertainment, platforms',
    risk: 'H',
    baseScore: 69,
    qualityScore: 5,
    earningsScore: 4,
    liquidityScore: 8,
    symbols: ['WBD', 'FOXA', 'LYV', 'CHTR', 'ROKU', 'PINS', 'SNAP', 'MTCH', 'ZM', 'BIDU', 'SPOT', 'DASH'],
  },
]

function broadUniverseCandidates(): CandidateMeta[] {
  return BROAD_US_STOCK_GROUPS.flatMap(group =>
    group.symbols.map((ticker, index) => candidate(
      ticker,
      clamp(group.baseScore - Math.floor(index / 12), 62, 78),
      group.risk,
      `broad liquid universe / ${group.theme} / trend and earnings validation`,
      100,
      group.sector,
      group.theme,
      group.qualityScore,
      group.earningsScore,
      group.liquidityScore
    ))
  )
}

function normalizeTickerSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, '').slice(0, 12)
}

function configuredUniverseSymbols(): string[] {
  const raw = getProfileEnvValue('HERMES_QUANT_UNIVERSE_SYMBOLS') ||
    process.env.HERMES_QUANT_UNIVERSE_SYMBOLS ||
    ''
  return Array.from(new Set(raw.split(/[,\s]+/).map(normalizeTickerSymbol).filter(Boolean)))
}

function candidateUniverseLimit(): number {
  const raw = getProfileEnvValue('HERMES_QUANT_UNIVERSE_MAX') ||
    process.env.HERMES_QUANT_UNIVERSE_MAX ||
    '300'
  return clamp(Number(raw), 10, 500)
}

function getCandidateUniverse(): CandidateMeta[] {
  const byTicker = new Map<string, CandidateMeta>()
  CANDIDATE_UNIVERSE.forEach(item => byTicker.set(item.ticker, item))
  configuredUniverseSymbols().forEach(ticker => {
    if (byTicker.has(ticker) || MARKET_SYMBOLS.includes(ticker)) return
    byTicker.set(ticker, {
      ticker,
      baseScore: 72,
      risk: 'M',
      reason: 'user configured universe / needs trend and earnings validation',
      fallbackPrice: 100,
      sector: 'Custom',
      theme: 'User universe',
      qualityScore: 4,
      earningsScore: 4,
      liquidityScore: 4,
    })
  })
  broadUniverseCandidates().forEach(item => {
    if (byTicker.has(item.ticker) || MARKET_SYMBOLS.includes(item.ticker)) return
    byTicker.set(item.ticker, item)
  })
  return Array.from(byTicker.values()).slice(0, candidateUniverseLimit())
}

function candidateRiskFromScreener(quote: YahooQuote): QuantLabRisk {
  const price = quote.regularMarketPrice ?? 0
  const marketCap = quote.marketCap ?? 0
  const changePct = Math.abs(quote.regularMarketChangePercent ?? 0)
  if (price < 5 || marketCap < 2_000_000_000 || changePct >= 10) return 'H'
  if (marketCap < 20_000_000_000 || changePct >= 5) return 'M'
  return 'L'
}

function candidateFromScreener(quote: YahooQuote, screenerId: typeof YAHOO_SCREENER_IDS[number], rank: number): CandidateMeta | null {
  const ticker = normalizeTickerSymbol(quote.symbol || '')
  if (!ticker || ticker.includes('=') || ticker.startsWith('^') || MARKET_SYMBOLS.includes(ticker)) return null

  const price = quote.regularMarketPrice ?? 0
  const volume = quote.regularMarketVolume ?? 0
  const avgVolume = quote.averageDailyVolume3Month ?? 0
  const marketCap = quote.marketCap ?? 0
  if (!Number.isFinite(price) || price < 2) return null
  if ((volume || avgVolume) < 1_000_000) return null
  if (marketCap > 0 && marketCap < 750_000_000) return null

  const changePct = quote.regularMarketChangePercent ?? 0
  const relVolume = avgVolume > 0 ? volume / avgVolume : 1
  const sourceBoost = screenerId === 'most_actives' ? 4 : screenerId === 'day_gainers' ? 6 : -2
  const momentumBoost = screenerId === 'day_losers'
    ? clamp(changePct * 0.35, -8, 2)
    : clamp(changePct * 0.45, -3, 8)
  const liquidityScore = clamp(Math.round(5 + Math.log10(Math.max(volume, avgVolume, 1_000_000)) - 6), 4, 10)
  const qualityScore = marketCap >= 200_000_000_000 ? 8 : marketCap >= 50_000_000_000 ? 7 : marketCap >= 10_000_000_000 ? 6 : 4
  const baseScore = clamp(Math.round(68 + sourceBoost + momentumBoost + Math.min(relVolume, 4) - (rank * 0.12)), 58, 86)
  const label = screenerId === 'most_actives'
    ? 'Yahoo most active flow'
    : screenerId === 'day_gainers'
      ? 'Yahoo top gainer momentum'
      : 'Yahoo top loser risk/reversal watch'

  return {
    ticker,
    baseScore,
    risk: candidateRiskFromScreener(quote),
    reason: `${label} / ${quote.shortName || ticker}`,
    fallbackPrice: price,
    sector: 'Yahoo Screener',
    theme: screenerId.replace(/_/g, ' '),
    qualityScore,
    earningsScore: 4,
    liquidityScore,
  }
}

async function fetchYahooScreenerCandidates(): Promise<{ candidates: CandidateMeta[]; detail: string }> {
  if (yahooScreenerCandidateCache && yahooScreenerCandidateCache.expiresAt > Date.now()) {
    return yahooScreenerCandidateCache
  }

  const byTicker = new Map<string, CandidateMeta>()
  const details: string[] = []
  await Promise.allSettled(YAHOO_SCREENER_IDS.map(async screenerId => {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(screenerId)}&count=${YAHOO_SCREENER_COUNT}`
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'Hermes Quant Lab/0.1',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`${screenerId}: HTTP ${res.status}`)
    const json = await res.json() as { finance?: { result?: Array<{ quotes?: YahooQuote[] }> } }
    const rows = json.finance?.result?.[0]?.quotes || []
    details.push(`${screenerId}:${rows.length}`)
    rows.forEach((quote, index) => {
      const candidateMeta = candidateFromScreener(quote, screenerId, index + 1)
      if (!candidateMeta) return
      const existing = byTicker.get(candidateMeta.ticker)
      if (!existing || candidateMeta.baseScore > existing.baseScore) byTicker.set(candidateMeta.ticker, candidateMeta)
    })
  }))

  const candidates = Array.from(byTicker.values()).sort((a, b) => b.baseScore - a.baseScore || a.ticker.localeCompare(b.ticker))
  const result = {
    candidates,
    detail: candidates.length
      ? `Yahoo screeners ${details.sort().join(', ')} produced ${candidates.length} filtered candidates.`
      : 'Yahoo screeners returned no filtered candidates; using curated universe only.',
  }
  yahooScreenerCandidateCache = { ...result, expiresAt: Date.now() + YAHOO_SCREENER_CACHE_TTL_MS }
  return result
}

function mergeCandidateUniverses(baseUniverse: CandidateMeta[], dynamicUniverse: CandidateMeta[]): CandidateMeta[] {
  const byTicker = new Map<string, CandidateMeta>()
  baseUniverse.forEach(item => byTicker.set(item.ticker, item))
  dynamicUniverse.forEach(item => {
    const existing = byTicker.get(item.ticker)
    if (!existing || item.baseScore > existing.baseScore) byTicker.set(item.ticker, item)
  })
  return Array.from(byTicker.values()).slice(0, candidateUniverseLimit())
}

function quantExposureSector(meta: Pick<CandidateMeta, 'ticker' | 'sector' | 'theme'>): string {
  const text = `${meta.ticker} ${meta.sector || ''} ${meta.theme || ''}`.toLowerCase()
  if (/(semi|semis|chip|memory|eda|foundry|lithography)/i.test(text)) return 'SEMIS'
  if (/(software|cloud|cybersecurity|data cloud|ai software|enterprise)/i.test(text)) return 'SOFTWARE'
  if (/(health|glp|pharma|biotech|medtech)/i.test(text)) return 'HEALTHCARE'
  if (/(financial|bank|payment|insurance|exchange|asset management)/i.test(text)) return 'FINANCIALS'
  if (/(communication|streaming|telecom|media|gaming|ads)/i.test(text)) return 'COMMUNICATIONS'
  if (/(consumer|retail|travel|restaurant|auto|housing)/i.test(text)) return 'CONSUMER'
  return getPortfolioSectorForTicker(meta.ticker)
}

function buildQuantSectorMap(): Record<string, string> {
  return Object.fromEntries(getCandidateUniverse().map(meta => [meta.ticker, quantExposureSector(meta)]))
}

const PAPER_INITIAL_CAPITAL = 1000
const PAPER_MAX_SINGLE_ALLOCATION = 200
const PAPER_MAX_POSITIONS = 5
const PAPER_MIN_TRADE_AMOUNT = 25
const PAPER_MAX_DAILY_LOSS_PCT = -2
const PAPER_MAX_DRAWDOWN_PCT = -10
const PAPER_MAX_CONSECUTIVE_LOSSES = 2
const PAPER_STOP_LOSS_PCT = -7
const PAPER_STOP_WARN_PCT = -5
const PAPER_VIX_WARN = 18
const PAPER_VIX_BLOCK = 20
const PAPER_VIX_SPIKE_PCT = 5
const PAPER_10Y_WARN_YIELD = 4.7
const PAPER_10Y_BLOCK_YIELD = 5
const PAPER_10Y_WARN_CHANGE = 0.03
const PAPER_10Y_BLOCK_CHANGE = 0.08
const YAHOO_DAILY_CANDLE_CACHE_TTL_MS = 3 * 60 * 1000
const yahooDailyCandleCache = new Map<string, { expiresAt: number; bars: QuantLabCandleBar[] }>()
const SENSITIVE_ENV_KEYS = [
  'ALPACA_API_KEY',
  'ALPACA_SECRET_KEY',
  'APCA_API_KEY_ID',
  'APCA_API_SECRET_KEY',
  'POLYGON_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_HOME_CHANNEL',
  'TELEGRAM_HOME_CHAT_ID',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'KK_TELEGRAM_ALLOWED_CHAT_IDS',
  'TELEGRAM_ALLOWED_USERS',
]
const SENSITIVE_OBJECT_KEY_RE = /(secret|token|password|passwd|api[_-]?key|key[_-]?id|chat[_-]?id|allowed[_-]chat|allowed[_-]user)/i

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function firstNumberFromText(value: string | null | undefined): number | null {
  const match = String(value || '').match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function knownSensitiveValues(): string[] {
  return SENSITIVE_ENV_KEYS
    .map(key => getProfileEnvValue(key))
    .filter((value): value is string => Boolean(value && value.trim().length >= 6))
}

function redactSensitiveText(value: unknown): string {
  let text = String(value ?? '')

  for (const secret of knownSensitiveValues()) {
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), maskSecretValue(secret))
  }

  return text
    .replace(/(apiKey=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:ALPACA|APCA|POLYGON|TELEGRAM)[A-Z0-9_]*(?:KEY|SECRET|TOKEN|CHAT_ID|USERS|IDS)\s*=\s*)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:ALPACA|APCA|POLYGON|TELEGRAM)[A-Z0-9_]*(?:KEY|SECRET|TOKEN|CHAT_ID|USERS|IDS)["']?\s*[:=]\s*["']?)[^"',\s<>]+/gi, '$1[redacted]')
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s"'<>]+/gi, 'https://api.telegram.org/bot[redacted]')
    .replace(/\bPK[A-Z0-9]{12,}\b/g, match => maskSecretValue(match))
}

function scrubSensitiveValue(value: unknown, keyHint = '', depth = 0): unknown {
  if (depth > 6) return '[redacted-depth]'
  if (typeof value === 'string') {
    return SENSITIVE_OBJECT_KEY_RE.test(keyHint) ? maskSecretValue(value) : redactSensitiveText(value)
  }
  if (Array.isArray(value)) return value.map(item => scrubSensitiveValue(item, '', depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
      key,
      SENSITIVE_OBJECT_KEY_RE.test(key)
        ? maskSecretValue(String(nestedValue ?? ''))
        : scrubSensitiveValue(nestedValue, key, depth + 1),
    ]))
  }
  return value
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return redactSensitiveText(err.message)
  return redactSensitiveText(String(err || 'Unknown error'))
}

const MIROFISH_RAW_GATEWAY_ERROR_RE = /\bTraceback\b|\bPython\b|\bSyntaxError\b|\bJSONDecodeError\b|\bPydantic\b|\bValidationError\b|\bTypeError\b|\bValueError\b|NoneType|object is not iterable|\bInternal Server Error\b|\bHTTP\s*500\b/i

function sanitizeMiroFishGatewayText(value: unknown): string | undefined {
  const text = String(value || '').trim()
  if (!text) return undefined
  if (MIROFISH_RAW_GATEWAY_ERROR_RE.test(text)) return MIROFISH_SAFE_GATEWAY_ALERT
  return redactSensitiveText(text)
}

function miroFishSafeErrorMessage(err: unknown, fallback = MIROFISH_SAFE_GATEWAY_ALERT): string {
  if (err instanceof Error) return sanitizeMiroFishGatewayText(err.message) || fallback
  return sanitizeMiroFishGatewayText(err) || fallback
}

function parseMiroFishBackendJsonText(text: string): { body: any; error?: string } {
  if (!text.trim()) return { body: {} }
  if (MIROFISH_RAW_GATEWAY_ERROR_RE.test(text)) {
    return { body: {}, error: MIROFISH_SAFE_GATEWAY_ALERT }
  }
  try {
    const body = JSON.parse(text)
    const rawError = body?.error || body?.detail || body?.message
    return {
      body,
      error: sanitizeMiroFishGatewayText(rawError),
    }
  } catch {
    return { body: {}, error: MIROFISH_SAFE_GATEWAY_ALERT }
  }
}

function quoteBundle(input: {
  source: string
  quotes: Map<string, YahooQuote>
  startedAt: number
  providerErrors?: string[]
  fallbackUsed?: boolean
  delayed?: boolean
  providerChain?: string[]
  fallbackSymbols?: string[]
  providerStatus?: QuantLabProviderStatus[]
}): QuoteBundle {
  return {
    source: input.source,
    quotes: input.quotes,
    quoteLatencyMs: Date.now() - input.startedAt,
    providerErrors: input.providerErrors || [],
    fallbackUsed: Boolean(input.fallbackUsed),
    delayed: input.delayed ?? true,
    receivedAt: new Date().toISOString(),
    providerChain: input.providerChain || [input.source],
    fallbackSymbols: input.fallbackSymbols || [],
    providerStatus: input.providerStatus || [],
  }
}

function formatSignedPercent(value: number | null | undefined): string {
  if (!isNumber(value)) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatSignedNumber(value: number | null | undefined, decimals = 2): string {
  if (!isNumber(value)) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}`
}

function quotePrice(quote: YahooQuote | undefined, fallback: number): number {
  return isNumber(quote?.regularMarketPrice) ? quote!.regularMarketPrice! : fallback
}

function quoteChangePercent(quote: YahooQuote | undefined): number | null {
  if (isNumber(quote?.regularMarketChangePercent)) return quote!.regularMarketChangePercent!
  if (isNumber(quote?.regularMarketPrice) && isNumber(quote?.regularMarketPreviousClose) && quote!.regularMarketPreviousClose! > 0) {
    return ((quote!.regularMarketPrice! - quote!.regularMarketPreviousClose!) / quote!.regularMarketPreviousClose!) * 100
  }
  return null
}

function quoteChange(quote: YahooQuote | undefined): number | null {
  if (isNumber(quote?.regularMarketChange)) return quote!.regularMarketChange!
  if (isNumber(quote?.regularMarketPrice) && isNumber(quote?.regularMarketPreviousClose)) {
    return quote!.regularMarketPrice! - quote!.regularMarketPreviousClose!
  }
  return null
}

function providerStatus(
  provider: string,
  configured: boolean,
  status: QuantLabProviderStatus['status'],
  detail: string
): QuantLabProviderStatus {
  return { provider, configured, status, detail: redactSensitiveText(detail) }
}

function getAlpacaCredentials(): { keyId: string; secretKey: string } | null {
  const keyId = getProfileEnvValue('ALPACA_API_KEY') || getProfileEnvValue('APCA_API_KEY_ID')
  const secretKey = getProfileEnvValue('ALPACA_SECRET_KEY') || getProfileEnvValue('APCA_API_SECRET_KEY')
  if (!keyId || !secretKey) return null
  if (alpacaKeyProblem(keyId)) return null
  return { keyId, secretKey }
}

function polygonApiKey(): string | null {
  return getProfileEnvValue('POLYGON_API_KEY')
}

function toUsEquitySymbol(symbol: string): string | null {
  if (symbol.startsWith('^')) return null
  if (symbol === 'DX-Y.NYB' || symbol === 'CL=F') return null
  return symbol.replace('-', '.')
}

async function fetchAlpacaQuotes(symbols: string[]): Promise<Map<string, YahooQuote>> {
  const credentials = getAlpacaCredentials()
  if (!credentials) throw new Error('Alpaca: missing ALPACA_API_KEY/APCA_API_KEY_ID and ALPACA_SECRET_KEY/APCA_API_SECRET_KEY')

  const originalByProvider = new Map<string, string>()
  const providerSymbols = symbols
    .map(symbol => {
      const providerSymbol = toUsEquitySymbol(symbol)
      if (providerSymbol) originalByProvider.set(providerSymbol, symbol)
      return providerSymbol
    })
    .filter((symbol): symbol is string => Boolean(symbol))

  if (!providerSymbols.length) throw new Error('Alpaca: no supported US equity symbols in request')

  const url = `https://data.alpaca.markets/v2/stocks/bars/latest?symbols=${encodeURIComponent(Array.from(new Set(providerSymbols)).join(','))}&feed=iex`
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'APCA-API-KEY-ID': credentials.keyId,
      'APCA-API-SECRET-KEY': credentials.secretKey,
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) throw new Error(`Alpaca market data request failed: HTTP ${res.status}`)

  const json = await res.json() as {
    bars?: Record<string, { c?: number; o?: number; v?: number }>
  }
  const quotes = new Map<string, YahooQuote>()

  for (const [providerSymbol, bar] of Object.entries(json.bars || {})) {
    const original = originalByProvider.get(providerSymbol)
    const close = Number(bar?.c)
    const open = Number(bar?.o)
    if (!original || !Number.isFinite(close) || close <= 0) continue

    quotes.set(original, {
      symbol: original,
      shortName: `${original} via Alpaca IEX latest bar`,
      regularMarketPrice: close,
      regularMarketPreviousClose: Number.isFinite(open) && open > 0 ? open : undefined,
      regularMarketChange: Number.isFinite(open) && open > 0 ? close - open : undefined,
      regularMarketChangePercent: Number.isFinite(open) && open > 0 ? ((close - open) / open) * 100 : undefined,
      regularMarketVolume: Number.isFinite(bar?.v) ? Number(bar.v) : undefined,
    })
  }

  return quotes
}

async function fetchPolygonQuotes(symbols: string[]): Promise<Map<string, YahooQuote>> {
  const apiKey = polygonApiKey()
  if (!apiKey) throw new Error('Polygon: missing POLYGON_API_KEY')

  const originalByProvider = new Map<string, string>()
  const providerSymbols = symbols
    .map(symbol => {
      const providerSymbol = toUsEquitySymbol(symbol)
      if (providerSymbol) originalByProvider.set(providerSymbol, symbol)
      return providerSymbol
    })
    .filter((symbol): symbol is string => Boolean(symbol))

  if (!providerSymbols.length) throw new Error('Polygon: no supported US equity symbols in request')

  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(Array.from(new Set(providerSymbols)).join(','))}&apiKey=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) throw new Error(`Polygon snapshot request failed: HTTP ${res.status}`)

  const json = await res.json() as {
    tickers?: Array<{
      ticker?: string
      lastTrade?: { p?: number }
      day?: { c?: number; o?: number; v?: number }
      prevDay?: { c?: number }
    }>
  }
  const quotes = new Map<string, YahooQuote>()

  for (const item of json.tickers || []) {
    const providerSymbol = item.ticker || ''
    const original = originalByProvider.get(providerSymbol)
    const day = item.day
    const price = Number(item.lastTrade?.p ?? day?.c)
    const previousClose = Number(item.prevDay?.c ?? day?.o)
    if (!original || !Number.isFinite(price) || price <= 0) continue

    quotes.set(original, {
      symbol: original,
      shortName: `${original} via Polygon snapshot`,
      regularMarketPrice: price,
      regularMarketPreviousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : undefined,
      regularMarketChange: Number.isFinite(previousClose) && previousClose > 0 ? price - previousClose : undefined,
      regularMarketChangePercent: Number.isFinite(previousClose) && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : undefined,
      regularMarketVolume: Number.isFinite(day?.v) ? Number(day!.v) : undefined,
    })
  }

  return quotes
}

function normalizeCandleTimeframe(value: unknown): QuantLabCandleTimeframe {
  const raw = String(value || '15m').toLowerCase()
  if (raw === '5m' || raw === '5min' || raw === '5') return '5m'
  if (raw === '1h' || raw === '60m' || raw === 'hour') return '1h'
  if (raw === '1d' || raw === 'd' || raw === 'day') return '1d'
  return '15m'
}

function alpacaTimeframe(timeframe: QuantLabCandleTimeframe): string {
  if (timeframe === '5m') return '5Min'
  if (timeframe === '1h') return '1Hour'
  if (timeframe === '1d') return '1Day'
  return '15Min'
}

function polygonRange(timeframe: QuantLabCandleTimeframe): { multiplier: number; timespan: 'minute' | 'hour' | 'day' } {
  if (timeframe === '5m') return { multiplier: 5, timespan: 'minute' }
  if (timeframe === '1h') return { multiplier: 1, timespan: 'hour' }
  if (timeframe === '1d') return { multiplier: 1, timespan: 'day' }
  return { multiplier: 15, timespan: 'minute' }
}

function candleWindowStart(timeframe: QuantLabCandleTimeframe, limit: number): Date {
  const value = new Date()
  const cappedLimit = clamp(limit, 20, 500)
  if (timeframe === '1d') value.setDate(value.getDate() - Math.max(cappedLimit * 2, 90))
  else if (timeframe === '1h') value.setDate(value.getDate() - Math.max(Math.ceil(cappedLimit / 6) + 10, 30))
  else value.setDate(value.getDate() - Math.max(Math.ceil(cappedLimit / 20) + 5, 10))
  return value
}

function normalizeCandleBars(bars: QuantLabCandleBar[], limit: number): QuantLabCandleBar[] {
  return bars
    .filter(bar =>
      Number.isFinite(bar.time) &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.open > 0 &&
      bar.high > 0 &&
      bar.low > 0 &&
      bar.close > 0
    )
    .sort((a, b) => a.time - b.time)
    .slice(-clamp(limit, 20, 500))
    .map(bar => ({
      time: Math.floor(bar.time),
      open: Number(bar.open.toFixed(4)),
      high: Number(bar.high.toFixed(4)),
      low: Number(bar.low.toFixed(4)),
      close: Number(bar.close.toFixed(4)),
      volume: Number(Math.max(0, bar.volume || 0).toFixed(0)),
    }))
}

async function fetchAlpacaCandles(symbol: string, timeframe: QuantLabCandleTimeframe, limit: number): Promise<QuantLabCandleBar[]> {
  const credentials = getAlpacaCredentials()
  if (!credentials) throw new Error('Alpaca: missing ALPACA_API_KEY/APCA_API_KEY_ID and ALPACA_SECRET_KEY/APCA_API_SECRET_KEY')

  const providerSymbol = toUsEquitySymbol(symbol)
  if (!providerSymbol) throw new Error(`Alpaca: unsupported symbol ${symbol}`)

  const start = candleWindowStart(timeframe, limit).toISOString()
  const end = new Date().toISOString()
  const url =
    `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(providerSymbol)}` +
    `&timeframe=${encodeURIComponent(alpacaTimeframe(timeframe))}` +
    `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=${encodeURIComponent(String(clamp(limit * 3, 100, 1000)))}` +
    '&feed=iex&sort=asc'
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'APCA-API-KEY-ID': credentials.keyId,
      'APCA-API-SECRET-KEY': credentials.secretKey,
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(12_000),
  })

  if (!res.ok) throw new Error(`Alpaca candles request failed: HTTP ${res.status}`)

  const json = await res.json() as {
    bars?: Record<string, Array<{ t?: string; o?: number; h?: number; l?: number; c?: number; v?: number }>>
  }
  const rows = json.bars?.[providerSymbol] || []
  return normalizeCandleBars(rows.map(row => ({
    time: row.t ? Date.parse(row.t) / 1000 : Number.NaN,
    open: Number(row.o),
    high: Number(row.h),
    low: Number(row.l),
    close: Number(row.c),
    volume: Number(row.v || 0),
  })), limit)
}

async function fetchPolygonCandles(symbol: string, timeframe: QuantLabCandleTimeframe, limit: number): Promise<QuantLabCandleBar[]> {
  const apiKey = polygonApiKey()
  if (!apiKey) throw new Error('Polygon: missing POLYGON_API_KEY')

  const providerSymbol = toUsEquitySymbol(symbol)
  if (!providerSymbol) throw new Error(`Polygon: unsupported symbol ${symbol}`)

  const range = polygonRange(timeframe)
  const start = formatDateForApi(candleWindowStart(timeframe, limit))
  const end = formatDateForApi(new Date())
  const url =
    `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(providerSymbol)}` +
    `/range/${range.multiplier}/${range.timespan}/${encodeURIComponent(start)}/${encodeURIComponent(end)}` +
    `?adjusted=true&sort=asc&limit=5000&apiKey=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(12_000),
  })

  if (!res.ok) throw new Error(`Polygon candles request failed: HTTP ${res.status}`)

  const json = await res.json() as {
    results?: Array<{ t?: number; o?: number; h?: number; l?: number; c?: number; v?: number }>
  }
  return normalizeCandleBars((json.results || []).map(row => ({
    time: Number(row.t) / 1000,
    open: Number(row.o),
    high: Number(row.h),
    low: Number(row.l),
    close: Number(row.c),
    volume: Number(row.v || 0),
  })), limit)
}

async function fetchStooqDailyCandles(symbol: string, limit: number): Promise<QuantLabCandleBar[]> {
  const stooq = toStooqSymbol(symbol)
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`
  const res = await fetch(url, {
    headers: {
      accept: 'text/csv,*/*',
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) throw new Error(`Stooq candles request failed: HTTP ${res.status}`)

  const rows = (await res.text())
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(line => {
      const [dateValue, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = parseCsvLine(line)
      return {
        time: Date.parse(`${dateValue}T00:00:00.000Z`) / 1000,
        open: Number(openRaw),
        high: Number(highRaw),
        low: Number(lowRaw),
        close: Number(closeRaw),
        volume: Number(volumeRaw || 0),
      }
    })

  return normalizeCandleBars(rows, limit)
}

async function fetchYahooDailyCandles(symbol: string, limit: number): Promise<QuantLabCandleBar[]> {
  const providerSymbol = symbol.trim().toUpperCase()
  const range = limit > 160 ? '1y' : '6mo'
  const cacheKey = `${providerSymbol}:${range}`
  const cached = yahooDailyCandleCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.bars.slice(-clamp(limit, 20, 500))
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}` +
    `?range=${encodeURIComponent(range)}&interval=1d&includePrePost=false&events=div%2Csplits`
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) throw new Error(`Yahoo chart candles request failed: HTTP ${res.status}`)

  const json = await res.json() as {
    chart?: {
      error?: { code?: string; description?: string }
      result?: Array<{
        timestamp?: number[]
        indicators?: {
          quote?: Array<{
            open?: Array<number | null>
            high?: Array<number | null>
            low?: Array<number | null>
            close?: Array<number | null>
            volume?: Array<number | null>
          }>
        }
      }>
    }
  }
  const chartError = json.chart?.error
  if (chartError) {
    throw new Error(`Yahoo chart candles request failed: ${chartError.description || chartError.code || 'unknown error'}`)
  }

  const result = json.chart?.result?.[0]
  const timestamps = result?.timestamp || []
  const quote = result?.indicators?.quote?.[0]
  if (!timestamps.length || !quote) throw new Error(`Yahoo chart returned no daily candles for ${symbol}.`)

  const rows = timestamps.map((time, index) => ({
    time: Number(time),
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    volume: Number(quote.volume?.[index] || 0),
  }))

  const normalized = normalizeCandleBars(rows, 500)
  yahooDailyCandleCache.set(cacheKey, {
    expiresAt: Date.now() + YAHOO_DAILY_CANDLE_CACHE_TTL_MS,
    bars: normalized,
  })
  return normalized.slice(-clamp(limit, 20, 500))
}

function average(values: number[]): number | null {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentChange(current: number | undefined, previous: number | undefined): number | null {
  if (!isNumber(current) || !isNumber(previous) || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = average(values)
  if (!isNumber(mean)) return null
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function dailySignalFromBars(ticker: string, bars: QuantLabCandleBar[]): QuantLabDailySignal | null {
  const cleanBars = normalizeCandleBars(bars, 120)
  const latest = cleanBars[cleanBars.length - 1]
  if (!latest) return null

  const closes = cleanBars.map(bar => bar.close)
  const volumes = cleanBars.map(bar => bar.volume).filter(value => Number.isFinite(value) && value > 0)
  const latestClose = closes[closes.length - 1]
  const previousClose = closes[closes.length - 2]
  const ma20 = average(closes.slice(-20))
  const ma60 = average(closes.slice(-60))
  let consecutiveUpDays = 0
  for (let index = closes.length - 1; index > 0; index -= 1) {
    if (closes[index] > closes[index - 1]) consecutiveUpDays += 1
    else break
  }
  const dailyReturns = closes
    .slice(-21)
    .map((close, index, window) => index === 0 ? null : percentChange(close, window[index - 1]))
    .filter(isNumber)
  const avgVolume20 = average(volumes.slice(-21, -1))

  return {
    ticker,
    source: 'yahoo-chart-delayed',
    bars: cleanBars.length,
    price: Number(latestClose.toFixed(2)),
    previousClose: isNumber(previousClose) ? Number(previousClose.toFixed(2)) : null,
    changePercent: percentChange(latestClose, previousClose),
    momentum20: percentChange(latestClose, closes[closes.length - 21]),
    momentum60: percentChange(latestClose, closes[closes.length - 61]),
    ma20: isNumber(ma20) ? Number(ma20.toFixed(2)) : null,
    ma60: isNumber(ma60) ? Number(ma60.toFixed(2)) : null,
    ma20DistancePct: percentChange(latestClose, ma20 ?? undefined),
    ma60DistancePct: percentChange(latestClose, ma60 ?? undefined),
    volatility20Pct: (() => {
      const dailyStd = standardDeviation(dailyReturns)
      return isNumber(dailyStd) ? dailyStd * Math.sqrt(252) : null
    })(),
    volumeRatio20: isNumber(avgVolume20) && avgVolume20 > 0 ? latest.volume / avgVolume20 : null,
    consecutiveUpDays,
  }
}

async function fetchYahooDailySignalMap(symbols: string[], limit = 90): Promise<Map<string, QuantLabDailySignal>> {
  const uniqueSymbols = Array.from(new Set(symbols.map(symbol => symbol.trim().toUpperCase()).filter(Boolean)))
  const entries = await Promise.allSettled(uniqueSymbols.map(async symbol => {
    const bars = await fetchYahooDailyCandles(symbol, limit)
    return dailySignalFromBars(symbol, bars)
  }))

  const signals = new Map<string, QuantLabDailySignal>()
  entries.forEach((entry) => {
    if (entry.status === 'fulfilled' && entry.value) signals.set(entry.value.ticker, entry.value)
  })
  return signals
}

async function fetchYahooChartQuotes(symbols: string[]): Promise<Map<string, YahooQuote>> {
  const signals = await fetchYahooDailySignalMap(symbols, 90)
  return new Map(Array.from(signals.entries()).map(([symbol, signal]) => [symbol, {
    symbol,
    regularMarketPrice: signal.price,
    regularMarketPreviousClose: signal.previousClose ?? undefined,
    regularMarketChange: isNumber(signal.previousClose) ? signal.price - signal.previousClose : undefined,
    regularMarketChangePercent: signal.changePercent ?? undefined,
  } satisfies YahooQuote]))
}

async function buildCandleResponse(symbolInput: unknown, timeframeInput: unknown, limitInput: unknown) {
  const symbol = String(symbolInput || 'NVDA').trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, '').slice(0, 12) || 'NVDA'
  const timeframe = normalizeCandleTimeframe(timeframeInput)
  const limit = clamp(Number(limitInput || 80), 20, 240)
  const updatedAt = new Date().toISOString()
  const providerErrors: string[] = []
  const statuses: QuantLabProviderStatus[] = []

  const alpacaConfigured = Boolean(getAlpacaCredentials())
  statuses.push(providerStatus(
    'alpaca',
    alpacaConfigured,
    alpacaConfigured ? 'ready' : 'missing-key',
    alpacaConfigured ? 'Configured for real OHLCV.' : 'Set ALPACA_API_KEY/APCA_API_KEY_ID and ALPACA_SECRET_KEY/APCA_API_SECRET_KEY.'
  ))
  if (alpacaConfigured) {
    try {
      const bars = await fetchAlpacaCandles(symbol, timeframe, limit)
      if (bars.length) {
        statuses[statuses.length - 1] = providerStatus('alpaca', true, 'ok', `Returned ${bars.length} ${timeframe} bars.`)
        return {
          ok: true,
          symbol,
          timeframe,
          source: 'alpaca-market-data',
          status: 'OK' as QuantLabDataStatus,
          mode: 'real' as QuantLabTruthMode,
          bars,
          updatedAt,
          providerStatus: statuses,
          providerErrors,
          dataTruth: {
            area: 'Candles',
            mode: 'real' as QuantLabTruthMode,
            source: 'alpaca-market-data',
            detail: `${bars.length} ${timeframe} OHLCV bars.`,
          },
        }
      }
      statuses[statuses.length - 1] = providerStatus('alpaca', true, 'failed', 'No OHLCV rows returned.')
      providerErrors.push('Alpaca candles: no OHLCV rows returned')
    } catch (err) {
      const message = `Alpaca candles: ${errorMessage(err)}`
      statuses[statuses.length - 1] = providerStatus('alpaca', true, 'failed', message)
      providerErrors.push(message)
    }
  }

  const polygonConfigured = Boolean(polygonApiKey())
  statuses.push(providerStatus(
    'polygon',
    polygonConfigured,
    polygonConfigured ? 'ready' : 'missing-key',
    polygonConfigured ? 'Configured for real OHLCV.' : 'Set POLYGON_API_KEY.'
  ))
  if (polygonConfigured) {
    try {
      const bars = await fetchPolygonCandles(symbol, timeframe, limit)
      if (bars.length) {
        statuses[statuses.length - 1] = providerStatus('polygon', true, 'ok', `Returned ${bars.length} ${timeframe} bars.`)
        return {
          ok: true,
          symbol,
          timeframe,
          source: 'polygon-aggregates',
          status: 'OK' as QuantLabDataStatus,
          mode: 'real' as QuantLabTruthMode,
          bars,
          updatedAt,
          providerStatus: statuses,
          providerErrors,
          dataTruth: {
            area: 'Candles',
            mode: 'real' as QuantLabTruthMode,
            source: 'polygon-aggregates',
            detail: `${bars.length} ${timeframe} OHLCV bars.`,
          },
        }
      }
      statuses[statuses.length - 1] = providerStatus('polygon', true, 'failed', 'No OHLCV rows returned.')
      providerErrors.push('Polygon candles: no OHLCV rows returned')
    } catch (err) {
      const message = `Polygon candles: ${errorMessage(err)}`
      statuses[statuses.length - 1] = providerStatus('polygon', true, 'failed', message)
      providerErrors.push(message)
    }
  }

  if (timeframe === '1d') {
    try {
      const bars = await fetchStooqDailyCandles(symbol, limit)
      statuses.push(providerStatus('stooq', true, bars.length ? 'ok' : 'failed', bars.length ? `Returned ${bars.length} daily bars.` : 'No daily bars returned.'))
      if (bars.length) {
        return {
          ok: true,
          symbol,
          timeframe,
          source: 'stooq-daily-delayed',
          status: 'DEGRADED' as QuantLabDataStatus,
          mode: 'partial' as QuantLabTruthMode,
          bars,
          updatedAt,
          providerStatus: statuses,
          providerErrors,
          dataTruth: {
            area: 'Candles',
            mode: 'partial' as QuantLabTruthMode,
            source: 'stooq-daily-delayed',
            detail: `${bars.length} daily delayed OHLCV bars.`,
          },
        }
      }
    } catch (err) {
      const message = `Stooq candles: ${errorMessage(err)}`
      statuses.push(providerStatus('stooq', true, 'failed', message))
      providerErrors.push(message)
    }

    try {
      const bars = await fetchYahooDailyCandles(symbol, limit)
      statuses.push(providerStatus('yahoo-chart', true, bars.length ? 'ok' : 'failed', bars.length ? `Returned ${bars.length} daily bars.` : 'No daily bars returned.'))
      if (bars.length) {
        return {
          ok: true,
          symbol,
          timeframe,
          source: 'yahoo-chart-delayed',
          status: 'DEGRADED' as QuantLabDataStatus,
          mode: 'partial' as QuantLabTruthMode,
          bars,
          updatedAt,
          providerStatus: statuses,
          providerErrors,
          dataTruth: {
            area: 'Candles',
            mode: 'partial' as QuantLabTruthMode,
            source: 'yahoo-chart-delayed',
            detail: `${bars.length} daily delayed OHLCV bars.`,
          },
        }
      }
    } catch (err) {
      const message = `Yahoo chart candles: ${errorMessage(err)}`
      statuses.push(providerStatus('yahoo-chart', true, 'failed', message))
      providerErrors.push(message)
    }
  } else {
    statuses.push(providerStatus('stooq', true, 'skipped', 'Daily-only fallback skipped for intraday chart.'))
    statuses.push(providerStatus('yahoo-chart', true, 'skipped', 'Daily-only fallback skipped for intraday chart.'))
  }

  const detail = providerErrors.length
    ? providerErrors.join(' | ')
    : 'No real OHLCV provider is configured for this timeframe.'

  return {
    ok: true,
    symbol,
    timeframe,
    source: 'no-real-candles',
    status: 'FALLBACK' as QuantLabDataStatus,
    mode: 'fallback' as QuantLabTruthMode,
    bars: [] as QuantLabCandleBar[],
    updatedAt,
    providerStatus: statuses,
    providerErrors,
    message: detail,
    dataTruth: {
      area: 'Candles',
      mode: 'fallback' as QuantLabTruthMode,
      source: 'no-real-candles',
      detail,
    },
  }
}

function toneFromPercent(value: number | null, warnThreshold = 0.25): QuantLabTone {
  if (!isNumber(value)) return 'neutral'
  if (value > warnThreshold) return 'up'
  if (value < -warnThreshold) return 'down'
  return 'neutral'
}

function rankAction(score: number, changePercent: number | null, risk: QuantLabRisk): QuantLabAction {
  if (score >= 88 && (changePercent ?? 0) > -0.7 && risk !== 'H') return 'BUY'
  if (score >= 82 || risk === 'H') return 'WATCH'
  return 'HOLD'
}

async function fetchYahooQuotes(symbols: string[]): Promise<Map<string, YahooQuote>> {
  const uniqueSymbols = Array.from(new Set(symbols))
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(uniqueSymbols.join(','))}`
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    throw new Error(`Yahoo quote request failed: HTTP ${res.status}`)
  }

  const json = await res.json() as { quoteResponse?: { result?: YahooQuote[] } }
  const result = json.quoteResponse?.result || []
  return new Map(result.filter(item => item?.symbol).map(item => [item.symbol, item]))
}

function toStooqSymbol(symbol: string): string {
  if (symbol === 'DX-Y.NYB') return 'dx.f'
  if (symbol === 'CL=F') return 'cl.f'
  if (symbol === 'BRK-B') return 'brk-b.us'
  if (symbol.startsWith('^')) return symbol.toLowerCase()
  return `${symbol.toLowerCase().replace('-', '.')}.us`
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === ',' && !quoted) {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  return cells
}

function parseOverlayNumber(value: string | null | undefined): number | null {
  const cleaned = String(value || '').replace(/[%x,$]/g, '').trim()
  if (!cleaned || cleaned.toLowerCase() === 'n/a') return null
  const parsed = Number(cleaned)
  if (Number.isFinite(parsed)) return parsed
  const match = cleaned.match(/[-+]?\d+(?:\.\d+)?/)
  const firstNumber = match ? Number(match[0]) : Number.NaN
  return Number.isFinite(firstNumber) ? firstNumber : null
}

function overlayLabelToAction(label: string, score: number | null): QuantLabAction {
  if (/買進/.test(label) || (Number.isFinite(score) && Number(score) >= 78)) return 'BUY'
  if (/避開|停損|減倉|過熱/.test(label) || (Number.isFinite(score) && Number(score) < 62)) return 'HOLD'
  return 'WATCH'
}

function valuationRiskMatrix(score: number | null): { tier: string; cap: number; maxAction: QuantLabAction; warning: string } {
  if (!Number.isFinite(score)) return { tier: 'unknown', cap: 86, maxAction: 'WATCH', warning: '估值資料不足 / 不升級買進' }
  const value = Number(score)
  if (value >= 75) return { tier: 'margin-of-safety', cap: 99, maxAction: 'BUY', warning: '估值具安全邊際' }
  if (value >= 50) return { tier: 'reasonable', cap: 86, maxAction: 'BUY', warning: '估值合理 / 可偏多觀察' }
  if (value >= 25) return { tier: 'expensive', cap: 68, maxAction: 'WATCH', warning: '估值偏貴 / 等回測' }
  return { tier: 'overheated', cap: 60, maxAction: 'HOLD', warning: '估值過熱 / 等深回測 / 基本面需再確認' }
}

function applyMaxValuationAction(action: QuantLabAction, maxAction: QuantLabAction): QuantLabAction {
  if (maxAction === 'HOLD') return 'HOLD'
  if (maxAction === 'WATCH' && action === 'BUY') return 'WATCH'
  return action
}

async function getLatestValuationOverlayMap(): Promise<Map<string, QuantLabValuationOverlayRow>> {
  const rawDir = resolve(resolveKnowledgeRoot(), 'raw', 'market', 'quant-simulation')
  if (!existsSync(rawDir)) return new Map()

  try {
    const files = (await readdir(rawDir))
      .filter(name => name.endsWith('-top10-valuation-overlay.csv'))
      .sort()
    const latest = files[files.length - 1]
    if (!latest) return new Map()

    const sourceDate = latest.replace('-top10-valuation-overlay.csv', '')
    const targetPath = resolve(rawDir, latest)
    const lines = (await readFile(targetPath, 'utf-8')).trim().split(/\r?\n/).filter(Boolean)
    const [headerLine, ...rows] = lines
    if (!headerLine || !rows.length) return new Map()

    const headers = parseCsvLine(headerLine).map(header => header.trim())
    const bySymbol = new Map<string, QuantLabValuationOverlayRow>()
    for (const line of rows) {
      const cells = parseCsvLine(line)
      const record = new Map(headers.map((header, index) => [header, cells[index] || '']))
      const symbol = String(record.get('symbol') || '').trim().toUpperCase()
      if (!symbol) continue
      const adjusted = parseOverlayNumber(record.get('valuation_adjusted_master_score'))
      const fundamentalValueScore = parseOverlayNumber(record.get('fundamental_adjusted_value_score') || record.get('fundamental_value_score'))
      const matrix = valuationRiskMatrix(fundamentalValueScore)
      bySymbol.set(symbol, {
        symbol,
        quantMasterScore: parseOverlayNumber(record.get('quant_master_score')),
        quantValueProxy: parseOverlayNumber(record.get('quant_value_proxy')),
        fundamentalLabel: String(record.get('fundamental_label') || '').trim(),
        fundamentalValueScore,
        evFcf: String(record.get('ev_fcf') || '').trim(),
        baseGap: String(record.get('base_gap') || '').trim(),
        fundamentalApplicable: String(record.get('fundamental_applicable') || '').trim().toLowerCase() === 'yes',
        report: String(record.get('report') || '').trim(),
        valuationAdjustedMasterScore: adjusted,
        valuationMasterDelta: String(record.get('valuation_master_delta') || '').trim(),
        valuationAdjustedLabel: String(record.get('valuation_adjusted_label') || '').trim(),
        valuationAdjustedRank: parseOverlayNumber(record.get('valuation_adjusted_rank')),
        valuationRiskTier: String(record.get('valuation_risk_tier') || matrix.tier).trim(),
        valuationScoreCap: parseOverlayNumber(record.get('valuation_score_cap')) ?? matrix.cap,
        valuationMaxAction: (String(record.get('valuation_max_action') || matrix.maxAction).trim() || 'WATCH') as QuantLabAction,
        valuationWarning: String(record.get('valuation_warning') || matrix.warning).trim(),
        sourceFile: targetPath,
        sourceDate,
      })
    }
    return bySymbol
  } catch {
    return new Map()
  }
}

async function getLatestMasterDecisionFeedbackMap(): Promise<Map<string, QuantLabMasterDecisionFeedbackRow>> {
  const rawDir = resolve(resolveKnowledgeRoot(), 'raw', 'market', 'quant-simulation')
  if (!existsSync(rawDir)) return new Map()

  try {
    const files = (await readdir(rawDir))
      .filter(name => name.endsWith('-master-decision-feedback.csv'))
      .sort()
    const latest = files[files.length - 1]
    if (!latest) return new Map()

    const sourceDate = latest.replace('-master-decision-feedback.csv', '')
    const targetPath = resolve(rawDir, latest)
    const lines = (await readFile(targetPath, 'utf-8')).trim().split(/\r?\n/).filter(Boolean)
    const [headerLine, ...rows] = lines
    if (!headerLine || !rows.length) return new Map()

    const headers = parseCsvLine(headerLine).map(header => header.trim())
    const bySymbol = new Map<string, QuantLabMasterDecisionFeedbackRow>()
    for (const line of rows) {
      const cells = parseCsvLine(line)
      const record = new Map(headers.map((header, index) => [header, cells[index] || '']))
      const symbol = String(record.get('symbol') || '').trim().toUpperCase()
      if (!symbol) continue
      bySymbol.set(symbol, {
        symbol,
        decision: String(record.get('master_decision') || '').trim(),
        feedbackRank: parseOverlayNumber(record.get('feedback_rank')),
        feedbackAdjustedMasterScore: parseOverlayNumber(record.get('feedback_adjusted_master_score')),
        wfHealthStatus: String(record.get('wf_health_status') || '').trim(),
        wfBenchmark: String(record.get('wf_benchmark') || 'SPY').trim(),
        wfAvgAlphaVsSpy: parseOverlayNumber(record.get('wf_avg_alpha_vs_spy')),
        wfAvgOutperformSpyRate: parseOverlayNumber(record.get('wf_avg_outperform_spy_rate')),
        wfBenchmarkSampleCount: parseOverlayNumber(record.get('wf_benchmark_sample_count')),
        highPrecisionStatus: String(record.get('high_precision_status') || '').trim(),
        highPrecisionActionable: String(record.get('high_precision_actionable') || '').trim().toLowerCase() === 'yes',
        highPrecisionReason: String(record.get('high_precision_reason') || '').trim(),
        highConvictionStatus: String(record.get('high_conviction_status') || '').trim(),
        highConvictionActionable: String(record.get('high_conviction_actionable') || '').trim().toLowerCase() === 'yes',
        ultraAlertStatus: String(record.get('ultra_alert_status') || '').trim(),
        ultraAlertActionable: String(record.get('ultra_alert_actionable') || '').trim().toLowerCase() === 'yes',
        sourceFile: targetPath,
        sourceDate,
      })
    }
    return bySymbol
  } catch {
    return new Map()
  }
}

async function getLatestWfRollingPerformance(): Promise<QuantLabWfRollingPerformance | null> {
  const rawDir = resolve(resolveKnowledgeRoot(), 'raw', 'market', 'quant-simulation')
  if (!existsSync(rawDir)) return null

  try {
    const files = (await readdir(rawDir))
      .filter(name => name.endsWith('-wf-rolling-performance-summary.json'))
      .sort()
    const latest = files[files.length - 1]
    if (!latest) return null

    const sourceDate = latest.replace('-wf-rolling-performance-summary.json', '')
    const sourceFile = resolve(rawDir, latest)
    const raw = JSON.parse(await readFile(sourceFile, 'utf-8')) as Record<string, unknown>
    const stringList = (value: unknown): string[] => Array.isArray(value)
      ? value.map(item => String(item).trim()).filter(Boolean)
      : []
    const num = (key: string): number | null => {
      const value = raw[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      return parseOverlayNumber(String(value ?? ''))
    }
    const int = (key: string): number => {
      const value = num(key)
      return Number.isFinite(value) ? Math.trunc(Number(value)) : 0
    }

    return {
      date: String(raw.date || sourceDate),
      generatedAt: String(raw.generated_at || raw.generatedAt || ''),
      policy: String(raw.policy || ''),
      snapshotCount: int('snapshot_count'),
      avgReturn5d: num('avg_return_5d'),
      winRate5d: num('win_rate_5d'),
      sampleCount5d: int('sample_count_5d'),
      spyAvgReturn5d: num('spy_avg_return_5d'),
      avgAlphaVsSpy5d: num('avg_alpha_vs_spy_5d'),
      outperformSpyRate5d: num('outperform_spy_rate_5d'),
      outperformSpySampleCount5d: int('outperform_spy_sample_count_5d'),
      avgReturn10d: num('avg_return_10d'),
      winRate10d: num('win_rate_10d'),
      sampleCount10d: int('sample_count_10d'),
      spyAvgReturn10d: num('spy_avg_return_10d'),
      avgAlphaVsSpy10d: num('avg_alpha_vs_spy_10d'),
      outperformSpyRate10d: num('outperform_spy_rate_10d'),
      outperformSpySampleCount10d: int('outperform_spy_sample_count_10d'),
      avgReturn20d: num('avg_return_20d'),
      winRate20d: num('win_rate_20d'),
      sampleCount20d: int('sample_count_20d'),
      spyAvgReturn20d: num('spy_avg_return_20d'),
      avgAlphaVsSpy20d: num('avg_alpha_vs_spy_20d'),
      outperformSpyRate20d: num('outperform_spy_rate_20d'),
      outperformSpySampleCount20d: int('outperform_spy_sample_count_20d'),
      dailySampleCount: int('daily_sample_count'),
      dailyAvgReturn: num('daily_avg_return'),
      dailyWinRate: num('daily_win_rate'),
      dailyVol: num('daily_vol'),
      dailySharpeProxy: num('daily_sharpe_proxy'),
      dailyAvgAlphaVsSpy: num('daily_avg_alpha_vs_spy'),
      dailyOutperformSpyRate: num('daily_outperform_spy_rate'),
      dailyOutperformSpySampleCount: int('daily_outperform_spy_sample_count'),
      avgTurnover: num('avg_turnover'),
      latestTurnover: num('latest_turnover'),
      latestAdded: stringList(raw.latest_added),
      latestRemoved: stringList(raw.latest_removed),
      latestKept: stringList(raw.latest_kept),
      sourceFile,
      sourceDate,
    }
  } catch {
    return null
  }
}

function markdownMatch(text: string, pattern: RegExp): string {
  return text.match(pattern)?.[1]?.trim() || ''
}

function reportPathToRelativeLink(filePath: string): string {
  const knowledgeRoot = resolveKnowledgeRoot()
  return filePath
    .replace(`${knowledgeRoot}/`, '')
    .replace(/\.md$/, '')
}

async function getLatestSingleStockValuationMap(): Promise<Map<string, QuantLabSingleStockValuationRow>> {
  const reportDir = resolve(resolveKnowledgeRoot(), 'reports', 'daily', 'single-stock')
  if (!existsSync(reportDir)) return new Map()

  try {
    const files = (await readdir(reportDir))
      .filter(name => /^\d{4}-\d{2}-\d{2}-[a-z0-9.-]+-fundamental-valuation\.md$/i.test(name))
      .sort()
    const bySymbol = new Map<string, QuantLabSingleStockValuationRow>()

    for (const fileName of files) {
      const match = fileName.match(/^(\d{4}-\d{2}-\d{2})-([a-z0-9.-]+)-fundamental-valuation\.md$/i)
      if (!match) continue
      const [, sourceDate, rawSymbol] = match
      const symbol = rawSymbol.toUpperCase()
      const sourceFile = resolve(reportDir, fileName)
      const text = await readFile(sourceFile, 'utf-8')
      const valueText = markdownMatch(text, /\*\*Value score adjustment:\*\* `([^`]+)`/)

      bySymbol.set(symbol, {
        symbol,
        fundamentalLabel: markdownMatch(text, /\*\*Fundamental label:\*\* `([^`]+)`/),
        fundamentalValueScore: parseOverlayNumber(valueText),
        evFcf: markdownMatch(text, /- EV\/FCF: `([^`]+)`/),
        baseGap: markdownMatch(text, /\*\*Base case:\*\*[\s\S]*?Implied gap vs current price: `([^`]+)`/),
        report: reportPathToRelativeLink(sourceFile),
        sourceFile,
        sourceDate,
      })
    }
    return bySymbol
  } catch {
    return new Map()
  }
}

function valuationCapFromFundamentalScore(score: number | null): number | null {
  if (!Number.isFinite(score)) return null
  return valuationRiskMatrix(score).cap
}

async function fetchStooqQuotes(symbols: string[]): Promise<Map<string, YahooQuote>> {
  const stooqToOriginal = new Map<string, string>()
  const stooqSymbols = Array.from(new Set(symbols.map(symbol => {
    const stooq = toStooqSymbol(symbol)
    stooqToOriginal.set(stooq.toUpperCase(), symbol)
    return stooq
  })))
  const url = `https://stooq.com/q/l/?s=${stooqSymbols.map(encodeURIComponent).join('+')}&f=sd2t2ohlcv&h&e=csv`
  const res = await fetch(url, {
    headers: {
      accept: 'text/csv,*/*',
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    throw new Error(`Stooq quote request failed: HTTP ${res.status}`)
  }

  const csv = await res.text()
  const lines = csv.trim().split(/\r?\n/).slice(1)
  const quotes = new Map<string, YahooQuote>()

  for (const line of lines) {
    const [symbol, , , openRaw, , , closeRaw, volumeRaw] = parseCsvLine(line)
    const original = stooqToOriginal.get((symbol || '').toUpperCase())
    const open = Number(openRaw)
    const close = Number(closeRaw)
    const volume = Number(volumeRaw)

    if (!original || !Number.isFinite(open) || !Number.isFinite(close) || close <= 0) continue

    quotes.set(original, {
      symbol: original,
      regularMarketPrice: close,
      regularMarketPreviousClose: open > 0 ? open : undefined,
      regularMarketChange: open > 0 ? close - open : undefined,
      regularMarketChangePercent: open > 0 ? ((close - open) / open) * 100 : undefined,
      regularMarketVolume: Number.isFinite(volume) ? volume : undefined,
    })
  }

  return quotes
}

const FRED_FALLBACK_SERIES: Record<string, { id: string; name: string }> = {
  '^VIX': { id: 'VIXCLS', name: 'CBOE VIX close' },
  '^TNX': { id: 'DGS10', name: '10-year Treasury yield' },
}

async function fetchFredLatestQuote(symbol: string): Promise<YahooQuote | null> {
  const series = FRED_FALLBACK_SERIES[symbol]
  if (!series) return null

  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(series.id)}`
  const res = await fetch(url, {
    headers: {
      accept: 'text/csv,*/*',
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) throw new Error(`FRED ${series.id} request failed: HTTP ${res.status}`)

  const rows = (await res.text())
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(line => {
      const [dateValue, rawValue] = parseCsvLine(line)
      const value = Number(rawValue)
      return { date: dateValue, value }
    })
    .filter(item => item.date && Number.isFinite(item.value) && item.value > 0)

  const latest = rows.at(-1)
  if (!latest) return null

  const previous = rows.at(-2) || latest
  const change = latest.value - previous.value
  const changePercent = previous.value > 0 ? (change / previous.value) * 100 : undefined

  return {
    symbol,
    shortName: `${series.name} via FRED`,
    regularMarketPrice: latest.value,
    regularMarketPreviousClose: previous.value,
    regularMarketChange: change,
    regularMarketChangePercent: changePercent,
  }
}

async function addFredFallbackQuotes(bundle: QuoteBundle, symbols: string[]): Promise<QuoteBundle> {
  const enriched = new Map(bundle.quotes)
  const missingFallbacks = Array.from(new Set(symbols.filter(symbol => !enriched.has(symbol) && FRED_FALLBACK_SERIES[symbol])))
  if (!missingFallbacks.length) return { ...bundle, quotes: enriched }

  let added = 0
  const providerErrors = [...bundle.providerErrors]
  const fallbackSymbols = [...bundle.fallbackSymbols]
  await Promise.all(missingFallbacks.map(async symbol => {
    try {
      const quote = await fetchFredLatestQuote(symbol)
      if (!quote) return
      enriched.set(symbol, quote)
      added += 1
      fallbackSymbols.push(symbol)
    } catch (err) {
      // FRED is only a fallback for macro indicators; keep the rest of the quote bundle usable.
      providerErrors.push(`FRED ${symbol}: ${errorMessage(err)}`)
    }
  }))

  return {
    ...bundle,
    source: added ? `${bundle.source}+fred` : bundle.source,
    quotes: enriched,
    fallbackUsed: bundle.fallbackUsed || added > 0,
    providerErrors,
    providerChain: added ? [...bundle.providerChain, 'fred'] : bundle.providerChain,
    fallbackSymbols,
    providerStatus: [
      ...bundle.providerStatus,
      providerStatus('fred', true, added ? 'ok' : missingFallbacks.length ? 'failed' : 'skipped', added ? `Added ${added} macro series.` : 'No macro fallback rows added.'),
    ],
  }
}

async function fetchYahooDailyLatestQuote(symbol: string): Promise<YahooQuote | null> {
  const bars = await fetchYahooDailyCandles(symbol, 80)
  const latest = bars.at(-1)
  if (!latest) return null

  const previous = bars.at(-2) || latest
  const change = latest.close - previous.close
  const changePercent = previous.close > 0 ? (change / previous.close) * 100 : undefined

  return {
    symbol,
    shortName: `${symbol} via Yahoo Chart daily`,
    regularMarketPrice: latest.close,
    regularMarketPreviousClose: previous.close,
    regularMarketChange: change,
    regularMarketChangePercent: changePercent,
    regularMarketVolume: latest.volume,
  }
}

async function addMacroFallbackQuotes(bundle: QuoteBundle, symbols: string[]): Promise<QuoteBundle> {
  const fredBundle = await addFredFallbackQuotes(bundle, symbols)
  const enriched = new Map(fredBundle.quotes)
  const missingYahooDaily = Array.from(new Set(symbols.filter(symbol =>
    !enriched.has(symbol) && YAHOO_DAILY_MACRO_FALLBACK_SYMBOLS.has(symbol)
  )))
  if (!missingYahooDaily.length) return { ...fredBundle, quotes: enriched }

  let added = 0
  const providerErrors = [...fredBundle.providerErrors]
  const fallbackSymbols = [...fredBundle.fallbackSymbols]
  await Promise.all(missingYahooDaily.map(async symbol => {
    try {
      const quote = await fetchYahooDailyLatestQuote(symbol)
      if (!quote) return
      enriched.set(symbol, quote)
      added += 1
      fallbackSymbols.push(symbol)
    } catch (err) {
      providerErrors.push(`Yahoo Chart macro ${symbol}: ${errorMessage(err)}`)
    }
  }))

  return {
    ...fredBundle,
    source: added ? `${fredBundle.source}+yahoo-chart-macro` : fredBundle.source,
    quotes: enriched,
    fallbackUsed: fredBundle.fallbackUsed || added > 0,
    providerErrors,
    providerChain: added ? [...fredBundle.providerChain, 'yahoo-chart-macro'] : fredBundle.providerChain,
    fallbackSymbols,
    providerStatus: [
      ...fredBundle.providerStatus,
      providerStatus(
        'yahoo-chart-macro',
        true,
        added ? 'ok' : missingYahooDaily.length ? 'failed' : 'skipped',
        added ? `Added ${added} macro daily close rows.` : 'No Yahoo Chart macro rows added.'
      ),
    ],
  }
}

async function fetchStooqDailyHistory(symbol: string): Promise<HistoricalBar[]> {
  const stooq = toStooqSymbol(symbol)
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`
  const res = await fetch(url, {
    headers: {
      accept: 'text/csv,*/*',
      'user-agent': 'Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) throw new Error(`Stooq history request failed: HTTP ${res.status}`)

  const csv = await res.text()
  return csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(line => {
      const [dateValue, , , , closeRaw] = parseCsvLine(line)
      const close = Number(closeRaw)
      return { date: dateValue, close }
    })
    .filter(item => item.date && Number.isFinite(item.close) && item.close > 0)
    .slice(-1300)
}

function formatDateForApi(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function parseMoneyNumber(value: unknown): number {
  const raw = String(value || '').replace(/[$,]/g, '').trim()
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

async function fetchNasdaqDailyHistory(symbol: string): Promise<HistoricalBar[]> {
  const end = new Date()
  const start = new Date(end)
  start.setFullYear(end.getFullYear() - 5)
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical` +
    `?assetclass=etf&fromdate=${formatDateForApi(start)}&todate=${formatDateForApi(end)}&limit=9999`
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 Hermes Quant Lab/0.1',
    },
    signal: AbortSignal.timeout(12_000),
  })

  if (!res.ok) throw new Error(`Nasdaq history request failed: HTTP ${res.status}`)
  const json = await res.json() as { data?: { tradesTable?: { rows?: Array<{ date?: string; close?: string }> } } }
  const rows = json.data?.tradesTable?.rows || []

  return rows
    .map(row => ({
      date: row.date || '',
      close: parseMoneyNumber(row.close),
    }))
    .filter(item => item.date && Number.isFinite(item.close) && item.close > 0)
    .reverse()
}

function movingAverage(values: number[], index: number, period: number): number | null {
  if (index + 1 < period) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i += 1) sum += values[i]
  return sum / period
}

function backtestMetrics(name: string, bars: HistoricalBar[], investedOnPreviousClose: (index: number, closes: number[]) => boolean, status: string) {
  const closes = bars.map(item => item.close)
  const returns: number[] = []
  let equity = 1
  let peak = 1
  let maxDrawdown = 0

  for (let i = 1; i < closes.length; i += 1) {
    const invested = investedOnPreviousClose(i - 1, closes)
    const dailyReturn = invested ? (closes[i] / closes[i - 1]) - 1 : 0
    returns.push(dailyReturn)
    equity *= (1 + dailyReturn)
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, (equity - peak) / peak)
  }

  const years = Math.max(returns.length / 252, 0.01)
  const cagr = (Math.pow(equity, 1 / years) - 1) * 100
  const average = returns.reduce((sum, item) => sum + item, 0) / Math.max(returns.length, 1)
  const variance = returns.reduce((sum, item) => sum + Math.pow(item - average, 2), 0) / Math.max(returns.length - 1, 1)
  const stdev = Math.sqrt(variance)
  const sharpe = stdev > 0 ? (average / stdev) * Math.sqrt(252) : 0
  const activeReturns = returns.filter(item => item !== 0)
  const win = activeReturns.length ? (activeReturns.filter(item => item > 0).length / activeReturns.length) * 100 : 0

  return {
    strategy: name,
    cagr: `${cagr.toFixed(1)}%`,
    sharpe: sharpe.toFixed(2),
    maxDd: `${(maxDrawdown * 100).toFixed(1)}%`,
    win: `${win.toFixed(0)}%`,
    status,
  }
}

async function buildBacktestPack() {
  try {
    const [qqq, spy] = await Promise.all([
      fetchNasdaqDailyHistory('QQQ'),
      fetchNasdaqDailyHistory('SPY'),
    ])
    if (qqq.length < 260 || spy.length < 260) throw new Error('Not enough historical bars')

    const qqqCloses = qqq.map(item => item.close)
    const lastIndex = qqqCloses.length - 1
    const lastMa20 = movingAverage(qqqCloses, lastIndex, 20)
    const lastMa60 = movingAverage(qqqCloses, lastIndex, 60)
    const momentumActive = Boolean(lastMa20 && lastMa60 && qqqCloses[lastIndex] > lastMa20 && lastMa20 > lastMa60)
    const spyCloses = spy.map(item => item.close)
    const spyLastIndex = spyCloses.length - 1
    const spyMa200 = movingAverage(spyCloses, spyLastIndex, 200)
    const spyDefensiveActive = Boolean(spyMa200 && spyCloses[spyLastIndex] > spyMa200)

    return {
      source: 'Nasdaq daily history',
      backtests: [
        backtestMetrics(
          'QQQ Momentum 20/60',
          qqq,
          (index, closes) => {
            const ma20 = movingAverage(closes, index, 20)
            const ma60 = movingAverage(closes, index, 60)
            return Boolean(ma20 && ma60 && closes[index] > ma20 && ma20 > ma60)
          },
          momentumActive ? 'Active' : 'Cash'
        ),
        backtestMetrics('QQQ Buy & Hold', qqq, () => true, 'Benchmark'),
        backtestMetrics(
          'SPY Defensive 200D',
          spy,
          (index, closes) => {
            const ma200 = movingAverage(closes, index, 200)
            return Boolean(ma200 && closes[index] > ma200)
          },
          spyDefensiveActive ? 'Risk-on' : 'Defensive'
        ),
      ],
      backtestSummary: [
        `Source: Nasdaq daily history, ${qqq[0].date} to ${qqq.at(-1)?.date}`,
        `Current signal: QQQ 20/60 ${momentumActive ? 'active' : 'cash'}; SPY 200D ${spyDefensiveActive ? 'risk-on' : 'defensive'}`,
      ],
    }
  } catch {
    return {
      source: 'mock-local-fallback',
      backtests: SNAPSHOT.backtests,
      backtestSummary: SNAPSHOT.backtestSummary,
    }
  }
}

async function fetchQuoteBundle(symbols: string[]): Promise<QuoteBundle> {
  const startedAt = Date.now()
  const providerErrors: string[] = []
  const statuses: QuantLabProviderStatus[] = []

  const alpacaConfigured = Boolean(getAlpacaCredentials())
  statuses.push(providerStatus(
    'alpaca',
    alpacaConfigured,
    alpacaConfigured ? 'ready' : 'missing-key',
    alpacaConfigured ? 'Configured; attempted before public fallback feeds.' : 'Set ALPACA_API_KEY/APCA_API_KEY_ID and ALPACA_SECRET_KEY/APCA_API_SECRET_KEY.'
  ))
  if (alpacaConfigured) {
    try {
      const alpacaQuotes = await fetchAlpacaQuotes(symbols)
      if (alpacaQuotes.size > 0) {
        statuses[statuses.length - 1] = providerStatus('alpaca', true, 'ok', `Returned ${alpacaQuotes.size} symbols.`)
        return addMacroFallbackQuotes(quoteBundle({
          source: 'alpaca-market-data',
          quotes: alpacaQuotes,
          startedAt,
          providerErrors,
          delayed: false,
          providerChain: ['alpaca'],
          providerStatus: statuses,
        }), symbols)
      }
      statuses[statuses.length - 1] = providerStatus('alpaca', true, 'failed', 'No rows returned.')
      providerErrors.push('Alpaca: no rows returned')
    } catch (err) {
      const message = `Alpaca: ${errorMessage(err)}`
      statuses[statuses.length - 1] = providerStatus('alpaca', true, 'failed', message)
      providerErrors.push(message)
    }
  } else {
    providerErrors.push('Alpaca: missing API keys')
  }

  const polygonConfigured = Boolean(polygonApiKey())
  statuses.push(providerStatus(
    'polygon',
    polygonConfigured,
    polygonConfigured ? 'ready' : 'missing-key',
    polygonConfigured ? 'Configured; attempted after Alpaca.' : 'Set POLYGON_API_KEY.'
  ))
  if (polygonConfigured) {
    try {
      const polygonQuotes = await fetchPolygonQuotes(symbols)
      if (polygonQuotes.size > 0) {
        statuses[statuses.length - 1] = providerStatus('polygon', true, 'ok', `Returned ${polygonQuotes.size} symbols.`)
        return addMacroFallbackQuotes(quoteBundle({
          source: 'polygon-snapshot',
          quotes: polygonQuotes,
          startedAt,
          providerErrors,
          delayed: false,
          providerChain: ['alpaca', 'polygon'],
          providerStatus: statuses,
        }), symbols)
      }
      statuses[statuses.length - 1] = providerStatus('polygon', true, 'failed', 'No rows returned.')
      providerErrors.push('Polygon: no rows returned')
    } catch (err) {
      const message = `Polygon: ${errorMessage(err)}`
      statuses[statuses.length - 1] = providerStatus('polygon', true, 'failed', message)
      providerErrors.push(message)
    }
  } else {
    providerErrors.push('Polygon: missing API key')
  }

  try {
    const quotes = await fetchYahooQuotes(symbols)
    if (quotes.size > 0) {
      statuses.push(providerStatus('yahoo-finance', true, 'ok', `Returned ${quotes.size} symbols.`))
      return addMacroFallbackQuotes(quoteBundle({
        source: 'yahoo-finance-delayed',
        quotes,
        startedAt,
        providerErrors,
        providerChain: ['yahoo-finance'],
        providerStatus: statuses,
      }), symbols)
    }
    statuses.push(providerStatus('yahoo-finance', true, 'failed', 'No rows returned.'))
    providerErrors.push('Yahoo Finance: no rows returned')
  } catch (err) {
    // Fall through to Stooq. Yahoo may rate-limit anonymous requests.
    const message = `Yahoo Finance: ${errorMessage(err)}`
    statuses.push(providerStatus('yahoo-finance', true, 'failed', message))
    providerErrors.push(message)
  }

  try {
    const yahooChartQuotes = await fetchYahooChartQuotes(symbols)
    if (yahooChartQuotes.size > 0) {
      statuses.push(providerStatus('yahoo-chart', true, 'ok', `Returned ${yahooChartQuotes.size} daily close rows.`))
      return addMacroFallbackQuotes(quoteBundle({
        source: 'yahoo-chart-delayed',
        quotes: yahooChartQuotes,
        startedAt,
        providerErrors,
        fallbackUsed: true,
        providerChain: ['alpaca', 'polygon', 'yahoo-finance', 'yahoo-chart'],
        providerStatus: statuses,
      }), symbols)
    }
    statuses.push(providerStatus('yahoo-chart', true, 'failed', 'No daily close rows returned.'))
    providerErrors.push('Yahoo Chart: no rows returned')
  } catch (err) {
    const message = `Yahoo Chart: ${errorMessage(err)}`
    statuses.push(providerStatus('yahoo-chart', true, 'failed', message))
    providerErrors.push(message)
  }

  try {
    const stooqQuotes = await fetchStooqQuotes(symbols)
    if (stooqQuotes.size > 0) {
      statuses.push(providerStatus('stooq', true, 'ok', `Returned ${stooqQuotes.size} symbols.`))
      return addMacroFallbackQuotes(quoteBundle({
        source: 'stooq-delayed',
        quotes: stooqQuotes,
        startedAt,
        providerErrors,
        fallbackUsed: true,
        providerChain: ['alpaca', 'polygon', 'yahoo-finance', 'yahoo-chart', 'stooq'],
        providerStatus: statuses,
      }), symbols)
    }
    statuses.push(providerStatus('stooq', true, 'failed', 'No rows returned.'))
    providerErrors.push('Stooq: no rows returned')
  } catch (err) {
    const message = `Stooq: ${errorMessage(err)}`
    statuses.push(providerStatus('stooq', true, 'failed', message))
    providerErrors.push(message)
  }

  throw new Error(`No quote provider returned data: ${providerErrors.join(' | ')}`)
}

function buildMarketPulse(quotes: Map<string, YahooQuote>) {
  const spy = quotes.get('SPY')
  const qqq = quotes.get('QQQ')
  const vix = quotes.get('^VIX')
  const tnx = quotes.get('^TNX')
  const dxy = quotes.get('DX-Y.NYB')
  const oil = quotes.get('CL=F')

  const spyPct = quoteChangePercent(spy)
  const qqqPct = quoteChangePercent(qqq)
  const vixPct = quoteChangePercent(vix)
  const vixPrice = quotePrice(vix, 14.8)
  const tnxPrice = quotePrice(tnx, 43.1)
  const tnxYield = tnxPrice > 20 ? tnxPrice / 10 : tnxPrice
  const tnxChange = quoteChange(tnx)
  const tnxYieldChange = isNumber(tnxChange) ? tnxChange / 10 : null
  const dxyPrice = quotePrice(dxy, 104.2)
  const oilPrice = quotePrice(oil, 78.4)

  const regime =
    (spyPct ?? 0) > 0 && (qqqPct ?? 0) > 0 && (vixPct ?? 0) < 0
      ? 'Risk-on'
      : (spyPct ?? 0) < -0.7 || (qqqPct ?? 0) < -0.9 || (vixPct ?? 0) > 5
        ? 'Risk-off'
        : 'Mixed'

  const regimeTone: QuantLabTone = regime === 'Risk-on' ? 'up' : regime === 'Risk-off' ? 'down' : 'warn'

  return {
    pulse: [
      { label: 'SPY', value: formatSignedPercent(spyPct), tone: toneFromPercent(spyPct) },
      { label: 'QQQ', value: formatSignedPercent(qqqPct), tone: toneFromPercent(qqqPct) },
      { label: 'VIX', value: `${vixPrice.toFixed(1)} ${formatSignedPercent(vixPct)}`, tone: isNumber(vixPct) && vixPct > 0 ? 'warn' : 'down' as QuantLabTone },
      { label: '10Y', value: `${tnxYield.toFixed(2)}% ${formatSignedNumber(tnxYieldChange)}`, tone: isNumber(tnxYieldChange) && tnxYieldChange > 0 ? 'warn' : 'neutral' as QuantLabTone },
      { label: 'DXY', value: `${dxyPrice.toFixed(1)} ${formatSignedPercent(quoteChangePercent(dxy))}`, tone: toneFromPercent(quoteChangePercent(dxy)) },
      { label: 'Oil', value: `${oilPrice.toFixed(1)} ${formatSignedPercent(quoteChangePercent(oil))}`, tone: toneFromPercent(quoteChangePercent(oil)) },
      { label: 'Regime', value: regime, tone: regimeTone },
    ],
    regime,
    spyPct,
    qqqPct,
    vixPct,
    vixPrice,
    tnxYield,
    tnxYieldChange,
  }
}

function formatSignalPercent(value: number | null | undefined): string {
  return isNumber(value) ? formatSignedPercent(value) : 'n/a'
}

function buildTopPicks(
  quotes: Map<string, YahooQuote>,
  regime: string,
  vixPrice: number,
  dailySignals = new Map<string, QuantLabDailySignal>(),
  universe = getCandidateUniverse(),
  valuationOverlay = new Map<string, QuantLabValuationOverlayRow>(),
  singleStockValuations = new Map<string, QuantLabSingleStockValuationRow>(),
  masterFeedback = new Map<string, QuantLabMasterDecisionFeedbackRow>()
) {
  return universe
    .map(meta => {
      const quote = quotes.get(meta.ticker)
      const dailySignal = dailySignals.get(meta.ticker)
      const changePercent = dailySignal?.changePercent ?? quoteChangePercent(quote)
      const qualityScore = meta.qualityScore ?? 0
      const earningsScore = meta.earningsScore ?? 0
      const liquidityScore = meta.liquidityScore ?? 0
      const dailyMomentumScore = dailySignal
        ? clamp(((dailySignal.momentum20 ?? 0) * 0.38) + ((dailySignal.momentum60 ?? 0) * 0.18), -12, 14)
        : isNumber(changePercent) ? clamp(changePercent * 1.4, -7, 7) : 0
      const maScore = dailySignal
        ? (isNumber(dailySignal.ma20DistancePct) ? dailySignal.ma20DistancePct > 0 ? 3 : -3 : 0) +
          (isNumber(dailySignal.ma60DistancePct) ? dailySignal.ma60DistancePct > 0 ? 2 : -2 : 0)
        : 0
      const earningsBoost = clamp((earningsScore - 5) * 0.65, -4, 4)
      const qualityBoost = clamp((qualityScore - 5) * 0.45, -3, 3)
      const liquidityBoost = clamp((liquidityScore - 5) * 0.25, -2, 2)
      const volatilityPenalty = dailySignal?.volatility20Pct
        ? dailySignal.volatility20Pct > 55 ? 5 : dailySignal.volatility20Pct > 42 ? 3 : dailySignal.volatility20Pct > 32 ? 1 : 0
        : 0
      const volumeBoost = dailySignal && isNumber(dailySignal.volumeRatio20) && dailySignal.volumeRatio20 > 1.25 && (changePercent ?? 0) > 0 ? 1 : 0
      const riskPenalty = vixPrice >= 20 && meta.risk === 'H' ? 5 : vixPrice >= 20 && meta.risk === 'M' ? 2 : 0
      const regimeBoost = regime === 'Risk-on' && meta.risk !== 'L' ? 1 : regime === 'Risk-off' && meta.risk === 'L' ? 2 : 0
      const sectorBoost =
        regime === 'Risk-on' && (meta.theme?.toLowerCase().includes('ai') || meta.sector === 'Technology') ? 1 :
          regime === 'Risk-off' && (meta.sector === 'Consumer Staples' || meta.theme?.toLowerCase().includes('defensive')) ? 1 :
            0
      const rawScore = clamp(Math.round(
        meta.baseScore +
        qualityBoost +
        earningsBoost +
        liquidityBoost +
        dailyMomentumScore +
        maScore +
        volumeBoost +
        regimeBoost +
        sectorBoost -
        riskPenalty -
        volatilityPenalty
      ), 55, 99)
      const overlay = valuationOverlay.get(meta.ticker)
      const supplementalValuation = overlay ? undefined : singleStockValuations.get(meta.ticker)
      const valuationAdjustedScore = overlay?.valuationAdjustedMasterScore
      const supplementalMatrix = supplementalValuation ? valuationRiskMatrix(supplementalValuation.fundamentalValueScore) : null
      const valuationCap = supplementalValuation ? valuationCapFromFundamentalScore(supplementalValuation.fundamentalValueScore) : null
      const score = Number.isFinite(valuationAdjustedScore)
        ? clamp(Number(valuationAdjustedScore), 55, overlay?.valuationScoreCap ?? 99)
        : Number.isFinite(valuationCap)
          ? Math.min(rawScore, Number(valuationCap))
          : rawScore
      const rawAction = overlay
        ? overlayLabelToAction(overlay.valuationAdjustedLabel, score)
        : supplementalValuation
          ? overlayLabelToAction(supplementalValuation.fundamentalLabel, score)
          : rankAction(score, changePercent, meta.risk)
      const feedback = masterFeedback.get(meta.ticker)
      const gatedAction = feedback && !feedback.highPrecisionActionable && rawAction === 'BUY' ? 'WATCH' : rawAction
      const action = overlay
        ? applyMaxValuationAction(gatedAction, overlay.valuationMaxAction)
        : supplementalMatrix
          ? applyMaxValuationAction(gatedAction, supplementalMatrix.maxAction)
          : gatedAction
      const hasQuote = Boolean(quote)
      const price = dailySignal?.price ?? quotePrice(quote, meta.fallbackPrice)
      const notes = [
        `Base ${meta.baseScore}`,
        `Quality ${qualityScore}/10`,
        `Earnings ${earningsScore}/10`,
        `Liquidity ${liquidityScore}/10`,
        meta.sector ? `Sector ${meta.sector}` : '',
        meta.theme ? `Theme ${meta.theme}` : '',
        dailySignal
          ? `20D ${formatSignalPercent(dailySignal.momentum20)} / 60D ${formatSignalPercent(dailySignal.momentum60)}`
          : isNumber(changePercent) ? `Momentum ${formatSignedPercent(changePercent)}` : 'Momentum n/a',
      ].filter(Boolean)
      if (dailySignal) {
        notes.push(`20MA ${formatSignalPercent(dailySignal.ma20DistancePct)}`)
        notes.push(`Vol ${isNumber(dailySignal.volatility20Pct) ? `${dailySignal.volatility20Pct.toFixed(1)}%` : 'n/a'}`)
      }
      if (regimeBoost || sectorBoost) notes.push(`Regime +${regimeBoost + sectorBoost}`)
      if (volumeBoost) notes.push(`Volume +${volumeBoost}`)
      if (riskPenalty || volatilityPenalty) notes.push(`Risk -${riskPenalty + volatilityPenalty}`)
      if (overlay) {
        notes.push(`Valuation-adjusted Master ${score.toFixed(2)} (${overlay.valuationMasterDelta || 'delta n/a'})`)
        notes.push(`Valuation risk ${overlay.valuationRiskTier} / cap ${overlay.valuationScoreCap ?? 'n/a'} / max ${overlay.valuationMaxAction}`)
        if (overlay.valuationWarning) notes.push(overlay.valuationWarning)
        notes.push(`Fundamental ${overlay.fundamentalValueScore ?? 'n/a'} / Value proxy ${overlay.quantValueProxy ?? 'n/a'}`)
        if (overlay.evFcf) notes.push(`EV/FCF ${overlay.evFcf}`)
        if (overlay.baseGap) notes.push(`Base gap ${overlay.baseGap}`)
      } else if (supplementalValuation) {
        notes.push(`Single-stock valuation cap ${score.toFixed(2)} from raw ${rawScore}`)
        notes.push(`Valuation risk ${supplementalMatrix?.tier ?? 'unknown'} / cap ${Number.isFinite(valuationCap) ? Number(valuationCap).toFixed(2) : 'n/a'} / max ${supplementalMatrix?.maxAction ?? 'WATCH'}`)
        if (supplementalMatrix?.warning) notes.push(supplementalMatrix.warning)
        notes.push(`Fundamental ${supplementalValuation.fundamentalValueScore ?? 'n/a'} / cap ${Number.isFinite(valuationCap) ? Number(valuationCap).toFixed(2) : 'n/a'}`)
        if (supplementalValuation.evFcf) notes.push(`EV/FCF ${supplementalValuation.evFcf}`)
        if (supplementalValuation.baseGap) notes.push(`Base gap ${supplementalValuation.baseGap}`)
      }
      if (feedback && !feedback.highPrecisionActionable) {
        notes.push(`Research validation gate ${feedback.highPrecisionStatus || 'LOCKED'}: ${feedback.highPrecisionReason || 'not actionable'}`)
      } else if (feedback?.highPrecisionActionable) {
        const conviction = feedback.highConvictionActionable ? ' / high conviction passed' : ''
        const ultra = feedback.ultraAlertActionable ? ' / ultra 95% passed' : ''
        notes.push(`Research validation gate passed${conviction}${ultra}: ${feedback.highPrecisionReason}`)
      }
      if (!hasQuote && !dailySignal) notes.push('Fallback price')

      return {
        ticker: meta.ticker,
        score,
        action,
        trend: formatSignedPercent(changePercent),
        risk: meta.risk,
        reason: feedback && !feedback.highPrecisionActionable
          ? `等60%驗證 / ${feedback.highPrecisionReason || 'research validation gate locked'} / ${meta.reason}`
          : overlay
          ? `${overlay.valuationAdjustedLabel || action} / valuation-adjusted Master ${score.toFixed(2)} / ${overlay.fundamentalLabel || 'fundamental overlay'} / ${meta.reason}`
          : supplementalValuation
            ? `${supplementalValuation.fundamentalLabel || action} / single-stock valuation cap ${score.toFixed(2)} / ${meta.reason}`
            : dailySignal
              ? `${meta.reason} / ${meta.theme || meta.sector || 'broad universe'} / earnings ${earningsScore}/10 / 20D ${formatSignalPercent(dailySignal.momentum20)} / ${isNumber(dailySignal.ma20DistancePct) && dailySignal.ma20DistancePct >= 0 ? 'above' : 'below'} 20MA`
              : `${meta.reason} / ${meta.theme || meta.sector || 'broad universe'} / earnings ${earningsScore}/10`,
        price: Number(price.toFixed(2)),
        scoreBreakdown: {
          quality: Number((meta.baseScore + qualityBoost).toFixed(1)),
          momentum: Number((dailyMomentumScore + maScore + volumeBoost).toFixed(1)),
          earnings: Number(earningsBoost.toFixed(1)),
          liquidity: Number(liquidityBoost.toFixed(1)),
          regime: regimeBoost + sectorBoost,
          risk: -(riskPenalty + volatilityPenalty),
          final: score,
          rawFinal: rawScore,
          confidence: overlay || supplementalValuation ? 'high' : dailySignal && dailySignal.bars >= 60 ? 'high' : hasQuote && isNumber(changePercent) ? 'medium' : 'low',
          source: overlay
            ? `valuation-overlay:${overlay.sourceDate}`
            : supplementalValuation
              ? `single-stock-valuation:${supplementalValuation.sourceDate}`
              : dailySignal?.source || (hasQuote ? 'quote-delayed' : 'fallback-price'),
          sector: meta.sector || 'Unknown',
          theme: meta.theme || 'Broad',
          valuation: overlay ? {
            adjustedScore: score,
            originalScore: overlay.quantMasterScore ?? rawScore,
            delta: overlay.valuationMasterDelta,
            label: overlay.valuationAdjustedLabel,
            riskTier: overlay.valuationRiskTier,
            scoreCap: overlay.valuationScoreCap,
            maxAction: overlay.valuationMaxAction,
            warning: overlay.valuationWarning,
            rank: overlay.valuationAdjustedRank,
            fundamentalValueScore: overlay.fundamentalValueScore,
            valueProxy: overlay.quantValueProxy,
            evFcf: overlay.evFcf,
            baseGap: overlay.baseGap,
            applicable: overlay.fundamentalApplicable,
            report: overlay.report,
            sourceDate: overlay.sourceDate,
          } : supplementalValuation ? {
            adjustedScore: score,
            originalScore: rawScore,
            delta: `cap ${Number.isFinite(valuationCap) ? Number(valuationCap).toFixed(2) : 'n/a'}`,
            label: supplementalValuation.fundamentalLabel,
            riskTier: supplementalMatrix?.tier ?? 'unknown',
            scoreCap: valuationCap,
            maxAction: supplementalMatrix?.maxAction ?? 'WATCH',
            warning: supplementalMatrix?.warning ?? '估值資料不足 / 不升級買進',
            rank: null,
            fundamentalValueScore: supplementalValuation.fundamentalValueScore,
            valueProxy: null,
            evFcf: supplementalValuation.evFcf,
            baseGap: supplementalValuation.baseGap,
            applicable: true,
            report: supplementalValuation.report,
            sourceDate: supplementalValuation.sourceDate,
          } : undefined,
          highPrecision: feedback ? {
            status: feedback.highPrecisionStatus,
            actionable: feedback.highPrecisionActionable,
            reason: feedback.highPrecisionReason,
            decision: feedback.decision,
            feedbackRank: feedback.feedbackRank,
            feedbackAdjustedMasterScore: feedback.feedbackAdjustedMasterScore,
            highConvictionStatus: feedback.highConvictionStatus,
            highConvictionActionable: feedback.highConvictionActionable,
            ultraAlertStatus: feedback.ultraAlertStatus,
            ultraAlertActionable: feedback.ultraAlertActionable,
            wfHealthStatus: feedback.wfHealthStatus,
            benchmark: feedback.wfBenchmark,
            avgAlphaVsSpy: feedback.wfAvgAlphaVsSpy,
            avgOutperformSpyRate: feedback.wfAvgOutperformSpyRate,
            benchmarkSampleCount: feedback.wfBenchmarkSampleCount,
            sourceDate: feedback.sourceDate,
          } : undefined,
          notes,
        },
      }
    })
    .sort((a, b) => {
      if (valuationOverlay.size > 0) {
        const aValuation = a.scoreBreakdown.valuation
        const bValuation = b.scoreBreakdown.valuation
        if (aValuation && bValuation) {
          const aRank = aValuation.rank ?? Number.POSITIVE_INFINITY
          const bRank = bValuation.rank ?? Number.POSITIVE_INFINITY
          return aRank - bRank || b.score - a.score || a.ticker.localeCompare(b.ticker)
        }
        if (aValuation && !bValuation) return -1
        if (!aValuation && bValuation) return 1
      }
      return b.score - a.score || a.ticker.localeCompare(b.ticker)
    })
    .slice(0, 10)
}

function buildPaperPriceBook(
  quotes: Map<string, YahooQuote>,
  topPicks: ReturnType<typeof buildTopPicks>,
  quoteSource: string,
  updatedAt: string,
  universe = getCandidateUniverse()
): PaperPriceBookItem[] {
  const topPickByTicker = new Map(topPicks.map(pick => [pick.ticker, pick]))
  const equityQuoteSource = quoteSource.toLowerCase().includes('alpaca')
    ? 'alpaca-market-data'
    : quoteSource.toLowerCase().includes('polygon')
      ? 'polygon-snapshot'
      : quoteSource.toLowerCase().includes('yahoo') || quoteSource.toLowerCase().includes('stooq')
        ? 'delayed-public-quote'
        : quoteSource

  return universe.map(meta => {
    const quote = quotes.get(meta.ticker)
    const topPick = topPickByTicker.get(meta.ticker)
    return {
      ticker: meta.ticker,
      price: Number(quotePrice(quote, topPick?.price ?? meta.fallbackPrice).toFixed(2)),
      trend: formatSignedPercent(quoteChangePercent(quote)),
      source: quote ? equityQuoteSource : 'fallback-price',
      quoteSource,
      updatedAt,
    }
  })
}

function buildDecisionPortfolioContext(paper: PaperAccountState, priceBook: PaperPriceBookItem[], topPicks: ReturnType<typeof buildTopPicks>) {
  const sectorMap = buildQuantSectorMap()
  const priceByTicker = new Map(priceBook.map(item => [item.ticker, item.price]))
  const pickByTicker = new Map(topPicks.map(item => [item.ticker, item]))
  const currentPositions: HermesPortfolioPosition[] = paper.positions.map(position => {
    const marketPrice = priceByTicker.get(position.ticker) || pickByTicker.get(position.ticker)?.price || position.lastPrice
    return {
      ticker: position.ticker,
      value: Number((position.shares * marketPrice).toFixed(2)),
      sector: sectorMap[position.ticker] || getPortfolioSectorForTicker(position.ticker, sectorMap),
    }
  })
  const portfolioValue = Number((paper.cash + currentPositions.reduce((sum, position) => sum + position.value, 0)).toFixed(2))
  return { currentPositions, portfolioValue, sectorMap }
}

function buildDecision(input: {
  topPicks: ReturnType<typeof buildTopPicks>
  regime: string
  qqqPct: number | null
  vixPrice: number
  vixPct: number | null
  tnxYield: number
  tnxYieldChange: number | null
  dataStatus?: QuantLabDataStatus
  mirofishResult?: HermesSynthesizerMiroFishResult | null
  currentPositions?: HermesPortfolioPosition[]
  portfolioValue?: number
  sectorMap?: Record<string, string>
}) {
  const buyList = input.topPicks.filter(pick => pick.action === 'BUY').slice(0, 3).map(pick => pick.ticker)
  const watchList = input.topPicks.filter(pick => pick.action === 'WATCH').slice(0, 3).map(pick => pick.ticker)
  const primary = input.topPicks[0]
  const qqqText = formatSignedPercent(input.qqqPct)
  const vixText = `${input.vixPrice.toFixed(1)} ${formatSignedPercent(input.vixPct)}`
  const tnxText = `${input.tnxYield.toFixed(2)}% ${formatSignedNumber(input.tnxYieldChange)}`
  const macroRisk = calculateMacroRiskPressure({
    vixPrice: input.vixPrice,
    vixPct: input.vixPct,
    qqqPct: input.qqqPct,
    tnxYield: input.tnxYield,
    tnxYieldChange: input.tnxYieldChange,
    dataStatus: input.dataStatus,
  })
  const synthesis = primary
    ? synthesizeHermesDecision({
        ticker: primary.ticker,
        quantScore: primary.score,
        mirofishResult: input.mirofishResult,
        macroRisk,
        vix: input.vixPrice,
        price: primary.price,
        maxTradeValue: PAPER_MAX_SINGLE_ALLOCATION,
        minTradeValue: PAPER_MIN_TRADE_AMOUNT,
        currentPositions: input.currentPositions,
        portfolioValue: input.portfolioValue,
        sectorMap: input.sectorMap,
      })
    : null
  const synthesisText = synthesis
    ? `Phase 5 合成 ${synthesis.ticker}：${synthesis.action}，E[S_final] ${synthesis.expectedScore.toFixed(2)}，Macro risk ${synthesis.macroRisk.toFixed(2)}。`
    : 'Phase 5 合成尚無足夠標的。'

  return {
    conclusion: `${input.regime}。QQQ ${qqqText}，VIX ${vixText}，10Y ${tnxText}；${synthesisText}`,
    action: buyList.length
      ? `${buyList.join(' / ')} 是目前最高分買入候選；${watchList.join(' / ') || '其餘名單'} 保持觀察，等待突破或回測支撐。`
      : `目前沒有高信心買入候選；${watchList.join(' / ') || 'Top 10'} 先觀察，等待風險條件改善。`,
    invalidation: 'VIX 升破 20、QQQ 跌破 20MA、10Y 連三日走高，或單日帳戶虧損達 2% 時停止新增買入。',
    expectedScore: synthesis?.expectedScore ?? null,
    quantScore: synthesis?.quantScore ?? null,
    mirofishScore: synthesis?.mirofishScore ?? null,
    macroRisk,
    vix: synthesis?.vix ?? input.vixPrice,
    riskMultiplier: synthesis?.riskMultiplier ?? 1,
    macroRegime: synthesis?.macroRegime ?? 'Unknown',
    macroInsight: synthesis?.macroInsight ?? 'Macro Agent not available yet; default multiplier is 1.00.',
    weights: synthesis?.weights ?? null,
    weightRegime: synthesis?.weightRegime ?? null,
    weightRegimeLabel: synthesis?.weightRegimeLabel ?? null,
    synthesisAction: synthesis?.action ?? 'REJECT',
    terminalMessage: synthesis?.terminalMessage ?? '',
    actionPayload: synthesis?.actionPayload ?? null,
    portfolioExposure: synthesis?.portfolioExposure ?? null,
    synthesisReasons: synthesis?.reasons ?? [],
    synthesisFormula: synthesis?.formula ?? 'E[S_final] = ((w1 * S_quant) + (w2 * S_mirofish) - (w3 * R_macro)) * RiskMultiplier',
  }
}

function modeFromDataStatus(status: QuantLabDataStatus): QuantLabTruthMode {
  if (status === 'OK') return 'real'
  if (status === 'DEGRADED') return 'partial'
  if (status === 'FALLBACK') return 'fallback'
  return 'mock'
}

function buildDataTruth(input: {
  status: QuantLabDataStatus
  quoteSource: string
  quoteCoverage: string
  backtestSource: string
  fallbackUsed: boolean
  missingCount: number
  top10Source?: string
  top10Detail?: string
}): QuantLabDataTruthItem[] {
  const quoteMode = modeFromDataStatus(input.status)
  const backtestMode: QuantLabTruthMode = input.backtestSource.toLowerCase().includes('mock') ||
    input.backtestSource.toLowerCase().includes('fallback')
    ? 'mock'
    : 'real'
  const top10Mode: QuantLabTruthMode =
    quoteMode === 'real'
      ? 'real'
      : quoteMode === 'partial'
        ? 'partial'
        : input.quoteSource.includes('mock')
          ? 'mock'
          : 'fallback'

  return [
    {
      area: 'Quotes',
      mode: quoteMode,
      source: input.quoteSource,
      detail: `${input.quoteCoverage}${input.fallbackUsed ? ' with fallback' : ''}`,
    },
    {
      area: 'Top 10',
      mode: top10Mode,
      source: input.top10Source || input.quoteSource,
      detail: input.top10Detail || (input.missingCount ? `${input.missingCount} symbols missing` : 'All ranked symbols priced by provider.'),
    },
    {
      area: 'Candles',
      mode: 'fallback',
      source: 'no-real-candles',
      detail: 'Candles are loaded from /candles only; no generated visual bars.',
    },
    {
      area: 'Backtest',
      mode: backtestMode,
      source: input.backtestSource,
      detail: backtestMode === 'real' ? 'Historical source available.' : 'Fallback strategy statistics.',
    },
    {
      area: 'Paper',
      mode: 'real',
      source: 'local-server-state',
      detail: 'Paper account uses local server state only; no real brokerage execution.',
    },
  ]
}

function marketProviderReadiness(): QuantLabProviderStatus[] {
  const alpacaKey = getProfileEnvValue('ALPACA_API_KEY') || getProfileEnvValue('APCA_API_KEY_ID')
  const alpacaSecret = getProfileEnvValue('ALPACA_SECRET_KEY') || getProfileEnvValue('APCA_API_SECRET_KEY')
  const alpacaProblem = alpacaKeyProblem(alpacaKey)
  const alpacaConfigured = Boolean(alpacaKey && alpacaSecret && !alpacaProblem)
  const polygonKey = polygonApiKey()
  return [
    providerStatus(
      'alpaca',
      alpacaConfigured,
      alpacaProblem ? 'failed' : alpacaConfigured ? 'ready' : 'missing-key',
      alpacaProblem || (alpacaConfigured ? 'Configured.' : 'Set ALPACA_API_KEY/APCA_API_KEY_ID and ALPACA_SECRET_KEY/APCA_API_SECRET_KEY.')
    ),
    providerStatus(
      'polygon',
      Boolean(polygonKey),
      polygonKey ? 'ready' : 'missing-key',
      polygonKey ? 'Configured. Aggregate candles may work even when snapshot quotes are plan-limited.' : 'Set POLYGON_API_KEY.'
    ),
    providerStatus('yahoo-finance', true, 'skipped', 'Anonymous fallback provider; may rate-limit.'),
    providerStatus('yahoo-chart', true, 'skipped', 'Daily OHLCV fallback provider for quotes, Top 10, and 1D candles.'),
    providerStatus('stooq', true, 'skipped', 'Delayed public fallback provider.'),
  ]
}

function buildDataHealth(input: {
  quoteBundle: QuoteBundle
  requestedSymbols: string[]
  stockUniverseSize?: number
  backtestSource: string
  top10Source?: string
  top10Detail?: string
}) {
  const missingSymbols = input.requestedSymbols.filter(symbol => !input.quoteBundle.quotes.has(symbol))
  const coverageRatio = input.requestedSymbols.length > 0 ? input.quoteBundle.quotes.size / input.requestedSymbols.length : 0
  const nonMacroFallbackSymbols = input.quoteBundle.fallbackSymbols.filter(symbol => !ACCEPTED_MACRO_FALLBACK_SYMBOLS.has(symbol))
  const quoteSourceIsProviderFallback = input.quoteBundle.source.includes('mock') ||
    input.quoteBundle.source.includes('delayed') ||
    input.quoteBundle.source.includes('stooq') ||
    input.quoteBundle.source.includes('yahoo-finance')
  const status: QuantLabDataStatus =
    input.quoteBundle.quotes.size === 0
      ? 'ERROR'
      : input.quoteBundle.source.includes('mock')
        ? 'FALLBACK'
        : missingSymbols.length || nonMacroFallbackSymbols.length || quoteSourceIsProviderFallback || input.quoteBundle.providerErrors.length || coverageRatio < 0.9
          ? 'DEGRADED'
          : 'OK'

  return {
    status,
    quoteSource: input.quoteBundle.source,
    quoteProvider: input.quoteBundle.source,
    quoteCoverage: `${input.quoteBundle.quotes.size}/${input.requestedSymbols.length}`,
    quoteLatencyMs: input.quoteBundle.quoteLatencyMs,
    missingSymbols: missingSymbols.slice(0, 12),
    staleSymbols: [] as string[],
    fallbackSymbols: input.quoteBundle.fallbackSymbols.slice(0, 12),
    fallbackUsed: input.quoteBundle.fallbackUsed,
    delayed: input.quoteBundle.delayed,
    providerChain: input.quoteBundle.providerChain,
    providerErrors: input.quoteBundle.providerErrors.slice(0, 8),
    providerStatus: input.quoteBundle.providerStatus.length ? input.quoteBundle.providerStatus : marketProviderReadiness(),
    universeSize: input.requestedSymbols.length,
    stockUniverseSize: input.stockUniverseSize ?? Math.max(0, input.requestedSymbols.length - MARKET_SYMBOLS.length),
    receivedSymbols: Array.from(input.quoteBundle.quotes.keys()).sort(),
    backtestSource: input.backtestSource,
    updatedAt: input.quoteBundle.receivedAt,
    dataTruth: buildDataTruth({
      status,
      quoteSource: input.quoteBundle.source,
      quoteCoverage: `${input.quoteBundle.quotes.size}/${input.requestedSymbols.length}`,
      backtestSource: input.backtestSource,
      fallbackUsed: input.quoteBundle.fallbackUsed,
      missingCount: missingSymbols.length,
      top10Source: input.top10Source,
      top10Detail: input.top10Detail,
    }),
  }
}

async function getLatestMiroFishSeed() {
  try {
    const root = resolveKnowledgeRoot()
    const seedDir = resolve(root, 'raw', 'mirofish', 'seeds')
    if (!existsSync(seedDir)) return null

    const fileNames = (await readdir(seedDir))
      .filter(name => name.endsWith('-mirofish-seed.md'))
    if (!fileNames.length) return null

    const entries = await Promise.all(fileNames.map(async fileName => {
      const targetPath = resolve(seedDir, fileName)
      const fileStat = await stat(targetPath)
      return {
        status: 'seed_saved',
        fileName,
        path: targetPath,
        relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
        updatedAt: fileStat.mtime.toISOString(),
        size: fileStat.size,
      }
    }))

    return entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null
  } catch {
    return null
  }
}

function mirofishReportDir(): string {
  return resolve(resolveKnowledgeRoot(), 'raw', 'mirofish', 'reports')
}

async function getLatestMiroFishInference(): Promise<MiroFishInference | null> {
  try {
    const root = resolveKnowledgeRoot()
    const reportDir = mirofishReportDir()
    if (!existsSync(reportDir)) return null

    const fileNames = (await readdir(reportDir))
      .filter(name => name.endsWith('-mirofish-inference.json'))
    if (!fileNames.length) return null

    const entries = await Promise.all(fileNames.map(async fileName => {
      const targetPath = resolve(reportDir, fileName)
      const fileStat = await stat(targetPath)
      return { targetPath, updatedAt: fileStat.mtime.toISOString() }
    }))
    const latest = entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
    if (!latest) return null

    const parsed = JSON.parse(await readFile(latest.targetPath, 'utf-8')) as MiroFishInference
    return {
      ...parsed,
      reportPath: parsed.reportPath || latest.targetPath.replace(/\.json$/, '.md'),
      reportRelativePath: parsed.reportRelativePath ||
        (latest.targetPath.startsWith(root) ? latest.targetPath.slice(root.length + 1).replace(/\.json$/, '.md') : undefined),
    }
  } catch {
    return null
  }
}

export async function buildQuantLabSnapshot() {
  const curatedUniverse = getCandidateUniverse()
  const fallbackRequestedSymbols = Array.from(new Set([...MARKET_SYMBOLS, ...curatedUniverse.map(item => item.ticker)]))
  try {
    const [screenerPack, backtestPack, latestMiroFishSeed, latestMiroFishInference, valuationOverlay, singleStockValuations, masterFeedback, wfRollingPerformance] = await Promise.all([
      fetchYahooScreenerCandidates().catch(err => ({
        candidates: [] as CandidateMeta[],
        detail: `Yahoo screeners unavailable: ${errorMessage(err)}; using curated universe only.`,
      })),
      buildBacktestPack(),
      getLatestMiroFishSeed(),
      getLatestMiroFishInference(),
      getLatestValuationOverlayMap(),
      getLatestSingleStockValuationMap(),
      getLatestMasterDecisionFeedbackMap(),
      getLatestWfRollingPerformance(),
    ])
    const candidateUniverse = mergeCandidateUniverses(curatedUniverse, screenerPack.candidates)
    const requestedSymbols = Array.from(new Set([...MARKET_SYMBOLS, ...candidateUniverse.map(item => item.ticker)]))
    const quoteBundle = await fetchQuoteBundle(requestedSymbols)
    const { quotes, source } = quoteBundle
    if (quotes.size === 0) throw new Error('Quote providers returned no quotes')

    const market = buildMarketPulse(quotes)
    const dailySignals = await fetchYahooDailySignalMap(requestedSymbols, 90)
      .catch(() => new Map<string, QuantLabDailySignal>())
    const rankedSignalCount = candidateUniverse.filter(item => dailySignals.has(item.ticker)).length
    const topPicks = buildTopPicks(quotes, market.regime, market.vixPrice, dailySignals, candidateUniverse, valuationOverlay, singleStockValuations, masterFeedback)
    const priceBook = buildPaperPriceBook(quotes, topPicks, source, quoteBundle.receivedAt, candidateUniverse)
    const decisionPortfolio = buildDecisionPortfolioContext(readPaperAccount(), priceBook, topPicks)
    const dynamicCandidateCount = screenerPack.candidates.length
    const dataHealth = buildDataHealth({
      quoteBundle,
      requestedSymbols,
      stockUniverseSize: candidateUniverse.length,
      backtestSource: backtestPack.source,
      top10Source: rankedSignalCount ? 'yahoo-screener+yahoo-chart-delayed+valuation-overlay' : `yahoo-screener+${source}`,
      top10Detail: rankedSignalCount
        ? `${rankedSignalCount}/${candidateUniverse.length} ranked across curated + Yahoo screener universe (${curatedUniverse.length} curated, ${dynamicCandidateCount} dynamic). Valuation overlay rows: ${valuationOverlay.size}; single-stock valuation reports: ${singleStockValuations.size}; layered feedback rows: ${masterFeedback.size}. ${screenerPack.detail}`
        : `Ranked ${candidateUniverse.length} symbols from curated + Yahoo screener universe (${curatedUniverse.length} curated, ${dynamicCandidateCount} dynamic); daily indicators unavailable. ${screenerPack.detail}`,
    })
    const decision = buildDecision({
      topPicks,
      regime: market.regime,
      qqqPct: market.qqqPct,
      vixPrice: market.vixPrice,
      vixPct: market.vixPct,
      tnxYield: market.tnxYield,
      tnxYieldChange: market.tnxYieldChange,
      dataStatus: dataHealth.status,
      mirofishResult: latestMiroFishInference?.debate || null,
      currentPositions: decisionPortfolio.currentPositions,
      portfolioValue: decisionPortfolio.portfolioValue,
      sectorMap: decisionPortfolio.sectorMap,
    })

    return {
      ...SNAPSHOT,
      source,
      generatedAt: new Date().toISOString(),
      marketPulse: market.pulse,
      topPicks,
      decision,
      chartCaption: [
        `Source: ${source} (${quotes.size} symbols)`,
        `Market regime: ${market.regime}`,
        `Top signal: ${topPicks[0]?.ticker || 'n/a'} ${topPicks[0]?.score || 'n/a'}`,
      ],
      graphCaption: [
        `Scenario seed: ${topPicks.slice(0, 4).map(pick => pick.ticker).join(' / ')}`,
        `Macro pressure: VIX ${market.vixPrice.toFixed(1)}, 10Y ${market.tnxYield.toFixed(2)}%`,
      ],
      priceBook,
      dailySignals: Array.from(dailySignals.values()).sort((a, b) => a.ticker.localeCompare(b.ticker)),
      backtests: backtestPack.backtests,
      backtestSummary: backtestPack.backtestSummary,
      dataHealth,
      mirofishSeed: latestMiroFishSeed,
      mirofishInference: latestMiroFishInference,
      wfRollingPerformance,
    }
  } catch (err) {
    const [latestMiroFishSeed, latestMiroFishInference] = await Promise.all([
      getLatestMiroFishSeed(),
      getLatestMiroFishInference(),
    ])
    return {
      ...SNAPSHOT,
      source: 'mock-local-fallback',
      generatedAt: new Date().toISOString(),
      dailySignals: [] as QuantLabDailySignal[],
      dataHealth: {
        ...SNAPSHOT.dataHealth,
        status: 'FALLBACK' as QuantLabDataStatus,
        quoteProvider: 'mock-local',
        quoteLatencyMs: 0,
        fallbackUsed: true,
        delayed: false,
        providerChain: ['mock-local'],
        providerErrors: [errorMessage(err)].filter(Boolean),
        providerStatus: marketProviderReadiness().map(status => status.status === 'ready'
          ? { ...status, status: 'failed' as const, detail: `${status.provider} did not return usable rows before mock fallback.` }
          : status),
        fallbackSymbols: [],
        staleSymbols: [],
        universeSize: fallbackRequestedSymbols.length,
        stockUniverseSize: curatedUniverse.length,
        receivedSymbols: [],
        quoteCoverage: `0/${fallbackRequestedSymbols.length}`,
        missingSymbols: fallbackRequestedSymbols.slice(0, 12),
        updatedAt: new Date().toISOString(),
        dataTruth: buildDataTruth({
          status: 'FALLBACK',
          quoteSource: 'mock-local',
          quoteCoverage: `0/${fallbackRequestedSymbols.length}`,
          backtestSource: SNAPSHOT.dataHealth.backtestSource,
          fallbackUsed: true,
          missingCount: fallbackRequestedSymbols.length,
        }),
      },
      mirofishSeed: latestMiroFishSeed,
      mirofishInference: latestMiroFishInference,
    }
  }
}

function quantPhaseCheck(
  key: string,
  label: string,
  passed: boolean,
  detail: string,
  metadata?: Record<string, unknown>
): QuantLabPhaseValidationCheck {
  return {
    key,
    label,
    status: passed ? 'PASS' : 'FAIL',
    detail: redactSensitiveText(detail),
    metadata: metadata ? scrubSensitiveValue(metadata) as Record<string, unknown> : undefined,
  }
}

function quantPhaseResult(
  phase: number,
  key: QuantLabPhaseKey,
  title: string,
  checks: QuantLabPhaseValidationCheck[]
): QuantLabPhaseValidationResult {
  return {
    phase,
    key,
    title,
    status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL',
    checks,
  }
}

function snapshotUsesMock(snapshot: QuantLabSnapshot): boolean {
  return snapshot.source.toLowerCase().includes('mock') ||
    snapshot.dataHealth.quoteSource.toLowerCase().includes('mock') ||
    snapshot.dataHealth.status === 'FALLBACK' ||
    snapshot.dataHealth.status === 'ERROR'
}

function snapshotHasTrustedEquitySource(snapshot: QuantLabSnapshot): boolean {
  const quoteSource = snapshot.dataHealth.quoteSource.toLowerCase()
  const trustedEquitySource = quoteSource.includes('alpaca') || quoteSource.includes('polygon')
  const nonAcceptedFallback = (snapshot.dataHealth.fallbackSymbols || [])
    .some(symbol => !ACCEPTED_MACRO_FALLBACK_SYMBOLS.has(symbol))
  const coverage = parseQuoteCoverage(snapshot.dataHealth.quoteCoverage)
  return trustedEquitySource &&
    !snapshotUsesMock(snapshot) &&
    !nonAcceptedFallback &&
    coverage.received > 0 &&
    coverage.ratio >= 0.9
}

function resolveOpenClawRoot(): string {
  const configured = getProfileEnvValue('OPENCLAW_ROOT')
  if (configured) return resolve(configured)
  return '/Users/kk/Documents/Codex/Hermes-Quant-Workspace/openclaw'
}

function resolveDocumentsRoot(): string {
  const obsidianVault = getProfileEnvValue('OBSIDIAN_VAULT_PATH')
  if (obsidianVault) return resolve(obsidianVault, '..')

  const wikiPath = getProfileEnvValue('WIKI_PATH')
  const marker = '/Documents/'
  if (wikiPath && wikiPath.includes(marker)) {
    return resolve(wikiPath.slice(0, wikiPath.indexOf(marker) + marker.length - 1))
  }

  const homeDocs = resolve(process.env.HOME || homedir(), 'Documents')
  if (existsSync(homeDocs) && !homeDocs.includes('/.runtime/')) return homeDocs

  const localUserDocs = '/Users/kk/Documents'
  if (existsSync(localUserDocs)) return localUserDocs

  return homeDocs
}

function openClawRuntimeConfigured(): boolean {
  return Boolean(
    getProfileEnvValue('OPENCLAW_RUNTIME_URL') ||
    getProfileEnvValue('OPENCLAW_GATEWAY_URL') ||
    getProfileEnvValue('OPENCLAW_BASE_URL')
  )
}

async function ensureQuantLabKnowledgeScaffold(): Promise<{ root: string; directories: string[] }> {
  const root = resolveKnowledgeRoot()
  const directories = [
    root,
    resolve(root, 'trading-journal'),
    resolve(root, 'trading-journal', 'action-audit'),
    resolve(root, 'trading-journal', 'notifications'),
    resolve(root, 'trading-journal', 'post-mortems'),
    resolve(root, 'raw', 'mirofish', 'seeds'),
    resolve(root, 'raw', 'mirofish', 'reports'),
    resolve(root, 'raw', 'mirofish', 'evidence'),
  ]
  await Promise.all(directories.map(directory => mkdir(directory, { recursive: true })))
  return { root, directories }
}

async function validateQuantLabPhases(options: { ensure?: boolean } = {}) {
  if (options.ensure) await ensureQuantLabKnowledgeScaffold()

  const snapshot = await buildQuantLabSnapshot()
  const paper = readPaperAccount()
  markPaperToMarket(paper, snapshot)
  ensurePaperRiskState(paper)
  const coverage = parseQuoteCoverage(snapshot.dataHealth.quoteCoverage)
  const topPick = snapshot.topPicks[0]
  const candleProbe = topPick
    ? await buildCandleResponse(topPick.ticker, '1d', 40)
    : null
  const risk = evaluateTradingRisk(paper, snapshot)
  const slippageBuyProbe = applyPessimisticExecution({ side: 'BUY', marketPrice: 100 })
  const slippageSellProbe = applyPessimisticExecution({ side: 'SELL', marketPrice: 100 })
  const valuationBlockedPaperProbe = canOpenPaperBuy(
    createPaperAccount(),
    {
      ticker: 'VALUATION-BLOCK',
      score: 95,
      action: 'BUY',
      trend: '+0.00%',
      risk: 'L',
      reason: 'Phase validation synthetic overvalued BUY candidate.',
      price: 100,
      scoreBreakdown: {
        valuation: {
          maxAction: 'HOLD',
          riskTier: 'overheated',
          scoreCap: 60,
          warning: '估值過熱 / 等深回測 / 基本面需再確認',
        },
      },
    } as QuantLabSnapshot['topPicks'][number],
    snapshot
  )
  const exposureProbe = checkPortfolioExposure({
    currentPositions: [
      { ticker: 'NVDA', value: 200, sector: 'SEMIS' },
      { ticker: 'AVGO', value: 200, sector: 'SEMIS' },
    ],
    targetTicker: 'AMD',
    portfolioValue: 1000,
    sectorMap: buildQuantSectorMap(),
  })
  const riskOnWeights = calculateDynamicWeights(17)
  const neutralWeights = calculateDynamicWeights(20)
  const riskOffWeights = calculateDynamicWeights(26)
  const agentEvalProbe = evaluateTrade(
    {
      ticker: 'AMD',
      pnl: -12,
      pnlPct: -6,
      entryPrice: 200,
      exitPrice: 188,
      closedAt: new Date().toISOString(),
    },
    {
      ticker: 'AMD',
      quantScore: 95,
      quantAction: 'BUY',
      quantReason: 'Validation probe high score.',
      quantSource: 'phase-validation',
      mirofish: {
        bullishProbability: 0.7,
        bullishConfidence: 0.8,
        bearishProbability: 0.6,
        bearishConfidence: 0.9,
      },
      credibilityBefore: DEFAULT_AGENT_CREDIBILITY,
    },
    DEFAULT_AGENT_CREDIBILITY
  )
  const decisionSynthesis = snapshot.decision as typeof snapshot.decision & {
    expectedScore?: number | null
    quantScore?: number | null
    mirofishScore?: number | null
    macroRisk?: number | null
    riskMultiplier?: number | null
    macroRegime?: string | null
    vix?: number | null
    weights?: { w1: number; w2: number; w3: number } | null
    weightRegime?: string | null
    weightRegimeLabel?: string | null
    synthesisAction?: string
    terminalMessage?: string
  }
  const evidence = await buildMiroFishEvidencePack(snapshot, 'premarket', paper)
  const debate = await runMiroFishDebate(buildMiroFishDebateEvidencePack(snapshot, 'premarket', paper, evidence))
  const inference = applyMiroFishDebateToInference(buildLocalMiroFishInference(snapshot, 'premarket', paper, evidence), debate)
  const providerSettings = buildProviderSettings()
  const knowledgeRoot = resolveKnowledgeRoot()
  const actionAudit = actionAuditPath()
  const notifications = quantNotificationPath()
  const telegramTarget = resolveTelegramTarget()
  const openClawRoot = resolveOpenClawRoot()
  const openClawPackagePath = resolve(openClawRoot, 'package.json')
  const openClawMemoryWikiPath = resolve(openClawRoot, 'extensions', 'memory-wiki', 'README.md')

  const phases: QuantLabPhaseValidationResult[] = [
    quantPhaseResult(1, 'phase-1-data', '真實資料層', [
      quantPhaseCheck(
        'quote-source',
        '報價來源不是 mock/fallback',
        !snapshotUsesMock(snapshot),
        `${snapshot.dataHealth.status || 'OK'} / ${snapshot.dataHealth.quoteSource}`,
        { source: snapshot.source, providerChain: snapshot.dataHealth.providerChain }
      ),
      quantPhaseCheck(
        'quote-coverage',
        '報價覆蓋率至少 90%',
        coverage.ratio >= 0.9 && coverage.received > 0,
        `${snapshot.dataHealth.quoteCoverage}`,
        { received: coverage.received, total: coverage.total, ratio: coverage.ratio }
      ),
      quantPhaseCheck(
        'candles',
        'K 線資料可讀且標示來源',
        Boolean(candleProbe && candleProbe.bars.length >= 20 && candleProbe.mode !== 'mock'),
        candleProbe ? `${candleProbe.source} / ${candleProbe.bars.length} bars / ${candleProbe.mode}` : 'no top pick for candle probe'
      ),
      quantPhaseCheck(
        'truth-labels',
        '資料健康標籤完整',
        Array.isArray(snapshot.dataHealth.dataTruth) && snapshot.dataHealth.dataTruth.length >= 5,
        `${snapshot.dataHealth.dataTruth?.length || 0} truth rows`
      ),
    ]),
    quantPhaseResult(2, 'phase-2-selection', 'HERMES 全域選股層', [
      quantPhaseCheck(
        'universe-size',
        '股票池大於等於 300 檔',
        Number(snapshot.dataHealth.stockUniverseSize || snapshot.dataHealth.universeSize || 0) >= 300,
        `${snapshot.dataHealth.stockUniverseSize || 0} stocks / ${snapshot.dataHealth.universeSize || 0} symbols`
      ),
      quantPhaseCheck(
        'top10-count',
        '每日 Top 10 已產生',
        snapshot.topPicks.length === 10,
        `${snapshot.topPicks.length}/10`
      ),
      quantPhaseCheck(
        'top10-fields',
        '每檔都有分數、動作、理由與價格',
        snapshot.topPicks.every(pick => pick.ticker && Number.isFinite(pick.score) && pick.action && pick.reason && pick.price > 0),
        snapshot.topPicks.map(pick => `${pick.ticker} ${pick.score} ${pick.action}`).join(' / ')
      ),
      quantPhaseCheck(
        'score-breakdown',
        '選股分數含趨勢/財報/品質/流動性因子',
        snapshot.topPicks.every(pick => {
          const breakdown = (pick as typeof pick & { scoreBreakdown?: { source?: string; notes?: string[] } }).scoreBreakdown
          return Boolean(breakdown?.source && breakdown?.notes?.length)
        }),
        `${snapshot.topPicks.filter(pick => {
          const breakdown = (pick as typeof pick & { scoreBreakdown?: { notes?: string[] } }).scoreBreakdown
          return breakdown?.notes?.length
        }).length}/10 with breakdown`
      ),
    ]),
    quantPhaseResult(3, 'phase-3-risk', '風控閘門', [
      quantPhaseCheck(
        'risk-checks',
        '風控項目完整',
        ['data-health', 'paper-price-source', 'vix-spike', 'qqq-trend', 'ten-year-rise', 'ai-authority']
          .every(key => risk.checks.some(check => check.key === key)),
        risk.checks.map(check => `${check.key}:${check.status}`).join(' / ')
      ),
      quantPhaseCheck(
        'ai-boundary',
        'AI 不可繞過風控',
        risk.checks.some(check => check.key === 'ai-authority' && check.status === 'PASS'),
        risk.checks.find(check => check.key === 'ai-authority')?.reason || 'missing ai-authority check'
      ),
      quantPhaseCheck(
        'trusted-paper-source',
        '紙上交易使用可信股票報價',
        snapshotHasTrustedEquitySource(snapshot),
        `${snapshot.dataHealth.quoteSource}; fallback ${snapshot.dataHealth.fallbackSymbols?.join(', ') || 'none'}`
      ),
    ]),
    quantPhaseResult(4, 'phase-4-mirofish', 'MiroFish 量化推演層', [
      quantPhaseCheck(
        'evidence-pack',
        'Top 10 / 宏觀 / 風控證據包可生成',
        evidence.length >= 8,
        `${evidence.length} evidence items`
      ),
      quantPhaseCheck(
        'scenario-inference',
        '推演有支持、反對與中性結論',
        inference.support.length > 0 && inference.oppose.length > 0 && inference.neutral.length > 0,
        `${inference.status} / ${inference.confidence}`
      ),
      quantPhaseCheck(
        'multi-agent-debate',
        'Macro/Bull/Bear/Judge 多智能體情境 JSON 可解析',
        Boolean(
          inference.debate?.ok &&
          inference.debate.macro?.Regime &&
          Number.isFinite(inference.debate.macro.RiskMultiplier) &&
          inference.debate.scenarios.bullish.probability >= 0 &&
          inference.debate.scenarios.neutral.probability >= 0 &&
          inference.debate.scenarios.bearish.probability >= 0 &&
          Math.abs(
            inference.debate.scenarios.bullish.probability +
            inference.debate.scenarios.neutral.probability +
            inference.debate.scenarios.bearish.probability -
            1
          ) <= 0.02
        ),
        inference.debate
          ? `Macro ${inference.debate.macro.Regime} x${inference.debate.macro.RiskMultiplier}; B ${inference.debate.scenarios.bullish.probability} / N ${inference.debate.scenarios.neutral.probability} / S ${inference.debate.scenarios.bearish.probability}`
          : 'debate missing'
      ),
      quantPhaseCheck(
        'backend-boundary',
        'MiroFish 僅作推演不直接決策',
        inference.neutral.some(line => line.includes('AI 只能提出建議') || line.includes('不能繞過風控')),
        inference.neutral.join(' | ')
      ),
    ]),
    quantPhaseResult(5, 'phase-5-decision', 'HERMES 合成決策層', [
      quantPhaseCheck(
        'decision-text',
        '結論、動作、失效條件完整',
        Boolean(snapshot.decision.conclusion && snapshot.decision.action && snapshot.decision.invalidation),
        `${snapshot.decision.conclusion} / ${snapshot.decision.action} / ${snapshot.decision.invalidation}`
      ),
      quantPhaseCheck(
        'expected-score',
        'Phase 5 期望分數公式可計算',
        Number.isFinite(decisionSynthesis.expectedScore) &&
          Number.isFinite(decisionSynthesis.quantScore) &&
          Number.isFinite(decisionSynthesis.mirofishScore) &&
          Number.isFinite(decisionSynthesis.macroRisk) &&
          Number.isFinite(decisionSynthesis.riskMultiplier) &&
          Number.isFinite(decisionSynthesis.weights?.w1) &&
          Number.isFinite(decisionSynthesis.weights?.w2) &&
          Number.isFinite(decisionSynthesis.weights?.w3),
        `E ${decisionSynthesis.expectedScore ?? 'n/a'} / Q ${decisionSynthesis.quantScore ?? 'n/a'} / M ${decisionSynthesis.mirofishScore ?? 'n/a'} / R ${decisionSynthesis.macroRisk ?? 'n/a'} / Macro x${decisionSynthesis.riskMultiplier ?? 'n/a'} / ${decisionSynthesis.macroRegime || decisionSynthesis.weightRegimeLabel || 'no regime'}`
      ),
      quantPhaseCheck(
        'dynamic-weights',
        'VIX regime 會自動切換 Phase 5 權重',
        riskOnWeights.w1 === 0.6 &&
          riskOnWeights.w2 === 0.3 &&
          riskOnWeights.w3 === 0.1 &&
          neutralWeights.w1 === 0.3 &&
          neutralWeights.w2 === 0.5 &&
          neutralWeights.w3 === 0.2 &&
          riskOffWeights.w1 === 0.1 &&
          riskOffWeights.w2 === 0.2 &&
          riskOffWeights.w3 === 0.7,
        `VIX 17 => ${riskOnWeights.w1}/${riskOnWeights.w2}/${riskOnWeights.w3}; VIX 20 => ${neutralWeights.w1}/${neutralWeights.w2}/${neutralWeights.w3}; VIX 26 => ${riskOffWeights.w1}/${riskOffWeights.w2}/${riskOffWeights.w3}`
      ),
      quantPhaseCheck(
        'terminal-action',
        'BUY 時輸出隱形 SIMULATE_TRADE 指令，非 BUY 不觸發',
        decisionSynthesis.synthesisAction === 'BUY'
          ? Boolean(decisionSynthesis.terminalMessage?.includes('<ACTION>') && decisionSynthesis.terminalMessage.includes('SIMULATE_TRADE'))
          : Boolean(decisionSynthesis.terminalMessage && !decisionSynthesis.terminalMessage.includes('<ACTION>')),
        `${decisionSynthesis.synthesisAction || 'n/a'} / ${decisionSynthesis.terminalMessage || 'no terminal message'}`
      ),
      quantPhaseCheck(
        'portfolio-exposure-gate',
        'BUY 決策前會檢查同板塊曝險',
        exposureProbe.allowed === false &&
          exposureProbe.sector === 'SEMIS' &&
          exposureProbe.sectorPositionCount >= 2 &&
          exposureProbe.reason.includes('Blocked'),
        `${exposureProbe.allowed ? 'allowed' : 'blocked'} / ${exposureProbe.sector} / ${exposureProbe.sectorPositionCount} positions / ${(exposureProbe.sectorWeight * 100).toFixed(1)}%`
      ),
      quantPhaseCheck(
        'decision-inputs',
        '決策合成包含選股、宏觀、風控與回測',
        Boolean(snapshot.topPicks.length && snapshot.marketPulse.length >= 6 && risk.checks.length >= 6 && snapshot.backtests.length >= 3),
        `top ${snapshot.topPicks.length}; pulse ${snapshot.marketPulse.length}; risk ${risk.checks.length}; backtests ${snapshot.backtests.length}`
      ),
    ]),
    quantPhaseResult(6, 'phase-6-paper', 'Paper Trading 層', [
      quantPhaseCheck(
        'paper-account',
        '紙上帳戶狀態可讀',
        paper.version === 1 && paper.initialCapital === PAPER_INITIAL_CAPITAL && Array.isArray(paper.positions) && Array.isArray(paper.journal),
        `equity ${formatMoney(paperEquity(paper))}; positions ${paper.positions.length}; journal ${paper.journal.length}`
      ),
      quantPhaseCheck(
        'paper-only',
        '只做紙上交易，不連真實下單',
        true,
        'All account actions use local paper state and saved journals only.'
      ),
      quantPhaseCheck(
        'pessimistic-execution',
        '紙上成交套用 0.15% 悲觀滑價',
        slippageBuyProbe.executionPrice === 100.15 &&
          slippageSellProbe.executionPrice === 99.85 &&
          slippageBuyProbe.slippageRate === SLIPPAGE_RATE,
        `BUY 100 -> ${slippageBuyProbe.executionPrice}; SELL 100 -> ${slippageSellProbe.executionPrice}; rate ${(SLIPPAGE_RATE * 100).toFixed(2)}%`
      ),
      quantPhaseCheck(
        'valuation-paper-buy-guard',
        'server 端紙上買入會套用估值 maxAction 風控',
        valuationBlockedPaperProbe.ok === false && valuationBlockedPaperProbe.reason.includes('Valuation guard blocks'),
        valuationBlockedPaperProbe.reason
      ),
      quantPhaseCheck(
        'journal-audit',
        '交易日記可追蹤',
        Boolean(paperStatePath() && actionAudit.relativePath),
        `${paperStatePath()} / ${actionAudit.relativePath}`
      ),
    ]),
    quantPhaseResult(7, 'phase-7-memory', 'LLM Wiki / Obsidian 記憶層', [
      quantPhaseCheck(
        'knowledge-root',
        '知識庫路徑存在或可建立',
        options.ensure ? existsSync(knowledgeRoot) : Boolean(knowledgeRoot),
        knowledgeRoot
      ),
      quantPhaseCheck(
        'journal-paths',
        '交易日記、Action audit、通知路徑已定義',
        Boolean(actionAudit.relativePath && notifications.relativePath),
        `${actionAudit.relativePath} / ${notifications.relativePath}`
      ),
      quantPhaseCheck(
        'latest-memory',
        '可讀取最近推演種子或允許下次產生',
        Boolean(snapshot.mirofishSeed?.relativePath || resolveKnowledgeRoot()),
        snapshot.mirofishSeed?.relativePath || 'seed will be created on next MiroFish run'
      ),
    ]),
    quantPhaseResult(8, 'phase-8-openclaw', 'OpenClaw 背景監控層', [
      quantPhaseCheck(
        'source-present',
        'OpenClaw source 可讀',
        existsSync(openClawPackagePath),
        openClawPackagePath
      ),
      quantPhaseCheck(
        'memory-wiki-docs',
        'OpenClaw memory-wiki 文件可讀',
        existsSync(openClawMemoryWikiPath),
        openClawMemoryWikiPath
      ),
      quantPhaseCheck(
        'decision-boundary',
        'OpenClaw 不直接改交易狀態',
        true,
        openClawRuntimeConfigured()
          ? 'Runtime URL configured; Quant Lab keeps OpenClaw as event/evidence source only.'
          : 'Runtime URL not configured; source/docs monitor remains read-only.'
      ),
    ]),
    quantPhaseResult(9, 'phase-9-telegram', 'Telegram 通知層', [
      quantPhaseCheck(
        'target-configured',
        'Telegram token 與目標已設定',
        Boolean(telegramTarget.token && telegramTarget.chatId),
        telegramTarget.token && telegramTarget.chatId ? 'configured' : 'missing token or target'
      ),
      quantPhaseCheck(
        'notification-log',
        '通知記錄路徑可用',
        Boolean(notifications.relativePath),
        notifications.relativePath
      ),
      quantPhaseCheck(
        'importance-gate',
        '只推送重要事件',
        true,
        'Notifications below medium severity are logged instead of pushed unless forced.'
      ),
    ]),
    quantPhaseResult(10, 'phase-10-agent-eval', 'Agent 事後歸因與打分層', [
      quantPhaseCheck(
        'agent-score-update',
        '平倉後會更新 Quant/Bull/Bear 信用分',
        agentEvalProbe.updatedCredibility.quant < DEFAULT_AGENT_CREDIBILITY.quant &&
          agentEvalProbe.updatedCredibility.bull < DEFAULT_AGENT_CREDIBILITY.bull &&
          agentEvalProbe.updatedCredibility.bear > DEFAULT_AGENT_CREDIBILITY.bear,
        `Q ${agentEvalProbe.quantContribution.delta}; Bull ${agentEvalProbe.bullPrediction.delta}; Bear ${agentEvalProbe.bearWarning.delta}`
      ),
      quantPhaseCheck(
        'post-mortem-markdown',
        '可產生 Obsidian RAG 事後檢討 Markdown',
        agentEvalProbe.markdown.includes(`# Trade Post-Mortem: ${agentEvalProbe.ticker}`) &&
          agentEvalProbe.markdown.includes('Actionable Insight') &&
          agentEvalProbe.markdown.includes('Updated Agent Credibility'),
        `${agentEvalProbe.result} ${agentEvalProbe.pnlPct.toFixed(2)}% / ${agentEvalProbe.actionableInsight}`
      ),
      quantPhaseCheck(
        'post-mortem-path',
        '事後檢討報告有專用保存資料夾',
        Boolean(resolveKnowledgeRoot()),
        `trading-journal/post-mortems/${todayKey()}-[ticker]-[id].md`
      ),
    ]),
  ]

  const firstFailed = phases.find(phase => phase.status === 'FAIL') || null
  return {
    ok: !firstFailed,
    generatedAt: new Date().toISOString(),
    source: snapshot.source,
    quoteCoverage: snapshot.dataHealth.quoteCoverage,
    universeSize: snapshot.dataHealth.universeSize || 0,
    stockUniverseSize: snapshot.dataHealth.stockUniverseSize || 0,
    firstFailedPhase: firstFailed ? {
      phase: firstFailed.phase,
      key: firstFailed.key,
      title: firstFailed.title,
    } : null,
    phases,
  }
}

function parseEnvValue(raw: string, key: string): string | null {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const envKey = trimmed.slice(0, eqIdx).trim()
    if (envKey !== key) continue
    const value = trimmed.slice(eqIdx + 1).trim()
    return value.replace(/^['"]|['"]$/g, '') || null
  }
  return null
}

function getProfileEnvValue(key: string): string | null {
  if (process.env[key]?.trim()) return process.env[key]!.trim()

  try {
    const envPath = getActiveEnvPath()
    if (!existsSync(envPath)) return null
    return parseEnvValue(readFileSync(envPath, 'utf-8'), key)
  } catch {
    return null
  }
}

function maskSecretValue(value: string | null): string {
  if (!value) return ''
  if (looksLikeAlpacaEndpoint(value)) return 'endpoint-url'
  if (value.length <= 4) return 'set'
  return `••••${value.slice(-4)}`
}

function sanitizeProviderSecret(value: unknown, label: string): string {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.length > 4096) throw new Error(`${label} is too long`)
  if (/[\r\n]/.test(text)) throw new Error(`${label} cannot contain line breaks`)
  if (label === 'ALPACA_API_KEY' && looksLikeAlpacaEndpoint(text)) {
    throw new Error('ALPACA_API_KEY must be the key id only, not the paper-api endpoint. Paste the PK... API key and do not paste https://paper-api.alpaca.markets/v2.')
  }
  return text
}

function looksLikeAlpacaEndpoint(value: string | null | undefined): boolean {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return false
  return /^https?:\/\//.test(text) || text.includes('alpaca.markets') || /\/v2\/?$/.test(text)
}

function alpacaKeyProblem(value: string | null | undefined): string | null {
  if (!value) return null
  if (looksLikeAlpacaEndpoint(value)) {
    return 'ALPACA_API_KEY looks like the Alpaca endpoint URL. Clear Alpaca and paste the PK... API key id only.'
  }
  return null
}

function buildProviderSettings() {
  const alpacaKey = getProfileEnvValue('ALPACA_API_KEY') || getProfileEnvValue('APCA_API_KEY_ID')
  const alpacaSecret = getProfileEnvValue('ALPACA_SECRET_KEY') || getProfileEnvValue('APCA_API_SECRET_KEY')
  const polygonKey = polygonApiKey()
  const alpacaProblem = alpacaKeyProblem(alpacaKey)
  const alpacaConfigured = Boolean(alpacaKey && alpacaSecret && !alpacaProblem)

  return {
    ok: true,
    envPath: getActiveEnvPath(),
    updatedAt: new Date().toISOString(),
    providers: [
      {
        provider: 'alpaca',
        configured: alpacaConfigured,
        status: alpacaProblem ? 'failed' : alpacaConfigured ? 'ready' : 'missing-key',
        purpose: 'Live quotes and intraday OHLCV.',
        detail: alpacaProblem || (alpacaConfigured ? 'Configured.' : 'Paste API key id and secret key. Endpoint is not required.'),
        fields: [
          {
            key: 'ALPACA_API_KEY',
            configured: Boolean(alpacaKey),
            mask: maskSecretValue(alpacaKey),
            aliases: ['APCA_API_KEY_ID'],
          },
          {
            key: 'ALPACA_SECRET_KEY',
            configured: Boolean(alpacaSecret),
            mask: maskSecretValue(alpacaSecret),
            aliases: ['APCA_API_SECRET_KEY'],
          },
        ],
      },
      {
        provider: 'polygon',
        configured: Boolean(polygonKey),
        status: polygonKey ? 'ready' : 'missing-key',
        purpose: 'Backup quotes and aggregate OHLCV.',
        detail: polygonKey ? 'Configured. Snapshot quotes can still be plan-limited; aggregate candles are tested separately.' : 'Paste Polygon API key.',
        fields: [
          {
            key: 'POLYGON_API_KEY',
            configured: Boolean(polygonKey),
            mask: maskSecretValue(polygonKey),
            aliases: [] as string[],
          },
        ],
      },
    ],
  }
}

function providerProbeResult(
  status: 'missing-key' | 'ok' | 'failed' | 'skipped',
  detail: string,
  startedAt?: number,
  extra: Record<string, unknown> = {}
) {
  return {
    status,
    detail: redactSensitiveText(detail),
    latencyMs: startedAt ? Date.now() - startedAt : 0,
    ...(scrubSensitiveValue(extra) as Record<string, unknown>),
  }
}

async function runProviderFeedTest(provider: 'alpaca' | 'polygon', symbol: string, timeframe: QuantLabCandleTimeframe) {
  if (provider === 'alpaca') {
    const alpacaKey = getProfileEnvValue('ALPACA_API_KEY') || getProfileEnvValue('APCA_API_KEY_ID')
    const problem = alpacaKeyProblem(alpacaKey)
    if (problem) {
      return {
        provider,
        configured: true,
        quote: providerProbeResult('failed', problem),
        candles: providerProbeResult('failed', problem),
      }
    }
  }

  const configured = provider === 'alpaca' ? Boolean(getAlpacaCredentials()) : Boolean(polygonApiKey())
  if (!configured) {
    const detail = provider === 'alpaca'
      ? 'Missing ALPACA_API_KEY/ALPACA_SECRET_KEY.'
      : 'Missing POLYGON_API_KEY.'
    return {
      provider,
      configured,
      quote: providerProbeResult('missing-key', detail),
      candles: providerProbeResult('missing-key', detail),
    }
  }

  const quoteStartedAt = Date.now()
  const quote = await (async () => {
    try {
      const quotes = provider === 'alpaca'
        ? await fetchAlpacaQuotes([symbol])
        : await fetchPolygonQuotes([symbol])
      const row = quotes.get(symbol)
      if (!row || !isNumber(row.regularMarketPrice)) {
        return providerProbeResult('failed', `No quote returned for ${symbol}.`, quoteStartedAt)
      }
      return providerProbeResult('ok', `${symbol} quote ${row.regularMarketPrice}.`, quoteStartedAt, {
        price: row.regularMarketPrice,
        changePercent: quoteChangePercent(row),
      })
    } catch (err) {
      return providerProbeResult('failed', errorMessage(err), quoteStartedAt)
    }
  })()

  const candleStartedAt = Date.now()
  const candles = await (async () => {
    try {
      const bars = provider === 'alpaca'
        ? await fetchAlpacaCandles(symbol, timeframe, 40)
        : await fetchPolygonCandles(symbol, timeframe, 40)
      if (!bars.length) return providerProbeResult('failed', `No ${timeframe} OHLCV bars returned for ${symbol}.`, candleStartedAt)
      return providerProbeResult('ok', `${bars.length} ${timeframe} OHLCV bars returned.`, candleStartedAt, {
        bars: bars.length,
        latestClose: bars[bars.length - 1]?.close,
        latestTime: bars[bars.length - 1]?.time,
      })
    } catch (err) {
      return providerProbeResult('failed', errorMessage(err), candleStartedAt)
    }
  })()

  return {
    provider,
    configured,
    quote,
    candles,
  }
}

async function runStooqFeedTest(symbol: string, timeframe: QuantLabCandleTimeframe) {
  const quoteStartedAt = Date.now()
  const quote = await (async () => {
    try {
      const quotes = await fetchStooqQuotes([symbol])
      const row = quotes.get(symbol)
      if (!row || !isNumber(row.regularMarketPrice)) {
        return providerProbeResult('failed', `No delayed quote returned for ${symbol}.`, quoteStartedAt)
      }
      return providerProbeResult('ok', `${symbol} delayed quote ${row.regularMarketPrice}.`, quoteStartedAt, {
        price: row.regularMarketPrice,
        changePercent: quoteChangePercent(row),
      })
    } catch (err) {
      return providerProbeResult('failed', errorMessage(err), quoteStartedAt)
    }
  })()

  const candleStartedAt = Date.now()
  const candles = await (async () => {
    if (timeframe !== '1d') {
      return providerProbeResult('skipped', 'Stooq candle probe is daily-only; switch chart to 1D.', candleStartedAt)
    }

    try {
      const bars = await fetchStooqDailyCandles(symbol, 80)
      if (!bars.length) return providerProbeResult('failed', `No daily OHLCV bars returned for ${symbol}.`, candleStartedAt)
      return providerProbeResult('ok', `${bars.length} daily delayed OHLCV bars returned.`, candleStartedAt, {
        bars: bars.length,
        latestClose: bars[bars.length - 1]?.close,
        latestTime: bars[bars.length - 1]?.time,
      })
    } catch (err) {
      return providerProbeResult('failed', errorMessage(err), candleStartedAt)
    }
  })()

  return {
    provider: 'stooq',
    configured: true,
    quote,
    candles,
  }
}

async function runYahooChartFeedTest(symbol: string, timeframe: QuantLabCandleTimeframe) {
  const candleStartedAt = Date.now()
  const candles = await (async () => {
    if (timeframe !== '1d') {
      return providerProbeResult('skipped', 'Yahoo Chart candle probe is daily-only; switch chart to 1D.', candleStartedAt)
    }

    try {
      const bars = await fetchYahooDailyCandles(symbol, 80)
      if (!bars.length) return providerProbeResult('failed', `No daily OHLCV bars returned for ${symbol}.`, candleStartedAt)
      return providerProbeResult('ok', `${bars.length} daily delayed OHLCV bars returned.`, candleStartedAt, {
        bars: bars.length,
        latestClose: bars[bars.length - 1]?.close,
        latestTime: bars[bars.length - 1]?.time,
      })
    } catch (err) {
      return providerProbeResult('failed', errorMessage(err), candleStartedAt)
    }
  })()

  return {
    provider: 'yahoo-chart',
    configured: true,
    quote: providerProbeResult('skipped', 'Yahoo Chart is used as a daily OHLCV fallback; quote probe is not required.'),
    candles,
  }
}

async function testProviderFeeds(symbolInput: unknown, timeframeInput: unknown) {
  const symbol = String(symbolInput || 'NVDA').trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, '').slice(0, 12) || 'NVDA'
  const timeframe = normalizeCandleTimeframe(timeframeInput)
  const tests = await Promise.all([
    runProviderFeedTest('alpaca', symbol, timeframe),
    runProviderFeedTest('polygon', symbol, timeframe),
    runStooqFeedTest(symbol, timeframe),
    runYahooChartFeedTest(symbol, timeframe),
  ])
  const readyCount = tests.filter(row =>
    row.candles.status === 'ok' &&
    (row.quote.status === 'ok' || row.quote.status === 'skipped')
  ).length
  const partialCount = tests.filter(row =>
    row.quote.status === 'ok' || row.candles.status === 'ok'
  ).length
  const configuredCount = tests.filter(row => row.configured).length

  return {
    ok: true,
    symbol,
    timeframe,
    updatedAt: new Date().toISOString(),
    envPath: getActiveEnvPath(),
    status: readyCount > 0 ? 'OK' : partialCount > 0 ? 'PARTIAL' : configuredCount > 0 ? 'FAILED' : 'MISSING_KEY',
    tests,
  }
}

async function updateProviderSettings(body: any) {
  const alpacaKey = sanitizeProviderSecret(body?.alpacaKeyId, 'ALPACA_API_KEY')
  const alpacaSecret = sanitizeProviderSecret(body?.alpacaSecretKey, 'ALPACA_SECRET_KEY')
  const polygonKey = sanitizeProviderSecret(body?.polygonApiKey, 'POLYGON_API_KEY')
  const clear = Array.isArray(body?.clear) ? body.clear.map((key: unknown) => String(key)) : []
  const allowedClear = new Set(['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'APCA_API_KEY_ID', 'APCA_API_SECRET_KEY', 'POLYGON_API_KEY'])

  for (const key of clear) {
    if (!allowedClear.has(key)) throw new Error(`Unsupported provider setting: ${key}`)
    await saveEnvValue(key, '')
  }

  if (alpacaKey) await saveEnvValue('ALPACA_API_KEY', alpacaKey)
  if (alpacaSecret) await saveEnvValue('ALPACA_SECRET_KEY', alpacaSecret)
  if (polygonKey) await saveEnvValue('POLYGON_API_KEY', polygonKey)

  return buildProviderSettings()
}

function resolveKnowledgeRoot(): string {
  const wikiPath = getProfileEnvValue('WIKI_PATH')
  if (wikiPath) return resolve(wikiPath)

  const obsidianVault = getProfileEnvValue('OBSIDIAN_VAULT_PATH')
  if (obsidianVault) return resolve(obsidianVault, 'Hermes-Knowledge')

  return resolve(homedir(), 'Documents', 'KK-Obsidian', 'Hermes-Knowledge')
}

function safeMarkdownFileName(fileName: string | undefined): string {
  return safeJournalFileName(fileName, ['.md'])
}

function safeJournalFileName(fileName: string | undefined, allowedExtensions: string[]): string {
  const fallback = `${new Date().toISOString().slice(0, 10)}-quant-lab.md`
  const safe = basename(fileName || fallback)
    .replace(/[/:\\?%*|"<>]/g, '_')
    .replace(/\s+/g, '-')
    .trim()
  const normalized = safe || fallback
  const extension = extname(normalized).toLowerCase()
  if (allowedExtensions.includes(extension)) return normalized
  return `${normalized.replace(/\.[a-z0-9]+$/i, '')}${allowedExtensions[0] || '.md'}`
}

function safeJsonlFileName(fileName: string): string {
  return basename(fileName)
    .replace(/[/:\\?%*|"<>]/g, '_')
    .replace(/\s+/g, '-')
    .trim()
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoMinute(): string {
  return new Date().toISOString().slice(0, 16)
}

function nextDateKey(dateKey = todayKey()): string {
  const value = new Date(`${dateKey}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

function createPaperRiskState(dayStartEquity = PAPER_INITIAL_CAPITAL): PaperRiskState {
  return {
    tradingDate: todayKey(),
    dayStartEquity,
    buysToday: {},
    consecutiveLosses: 0,
  }
}

function normalizePaperRiskState(value: Partial<PaperRiskState> | null | undefined, dayStartEquity: number): PaperRiskState {
  const today = todayKey()
  const sameDay = value?.tradingDate === today
  const pauseNewBuysUntil = typeof value?.pauseNewBuysUntil === 'string' && value.pauseNewBuysUntil > today
    ? value.pauseNewBuysUntil
    : undefined

  return {
    tradingDate: today,
    dayStartEquity: sameDay && Number.isFinite(value?.dayStartEquity) ? Number(value!.dayStartEquity) : dayStartEquity,
    buysToday: sameDay && value?.buysToday && typeof value.buysToday === 'object' ? Object.fromEntries(
      Object.entries(value.buysToday)
        .filter(([ticker, time]) => ticker && typeof time === 'string')
        .map(([ticker, time]) => [ticker.toUpperCase(), time])
    ) : {},
    consecutiveLosses: pauseNewBuysUntil
      ? Number(value?.consecutiveLosses || 0)
      : typeof value?.pauseNewBuysUntil === 'string' && value.pauseNewBuysUntil <= today
        ? 0
        : Number.isFinite(value?.consecutiveLosses) ? Number(value!.consecutiveLosses) : 0,
    pauseNewBuysUntil,
    lastGuardrail: typeof value?.lastGuardrail === 'string' ? value.lastGuardrail : undefined,
  }
}

function phaseLabel(phase: QuantLabBriefPhase): string {
  return phase === 'premarket' ? '開盤前' : '收盤後'
}

function getPulseValue(snapshot: QuantLabSnapshot, label: string): string {
  return snapshot.marketPulse.find(item => item.label === label)?.value || 'n/a'
}

function parsePulseNumber(snapshot: QuantLabSnapshot, label: string): number | null {
  const raw = getPulseValue(snapshot, label)
  const match = raw.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

function parsePulseNumbers(snapshot: QuantLabSnapshot, label: string): number[] {
  return Array.from(getPulseValue(snapshot, label).matchAll(/[+-]?\d+(?:\.\d+)?/g))
    .map(match => Number(match[0]))
    .filter(Number.isFinite)
}

function getDailySignal(snapshot: QuantLabSnapshot, ticker: string): QuantLabDailySignal | null {
  const dailySignals = (snapshot as QuantLabSnapshot & { dailySignals?: QuantLabDailySignal[] }).dailySignals || []
  const normalized = ticker.toUpperCase()
  return dailySignals.find(signal => signal.ticker.toUpperCase() === normalized) || null
}

function dailySignalPercent(value: number | null | undefined): string {
  return isNumber(value) ? formatSignedPercent(value) : 'n/a'
}

function dailyYieldChange(signal: QuantLabDailySignal | null): number | null {
  if (!signal || !isNumber(signal.previousClose)) return null
  const currentYield = signal.price > 20 ? signal.price / 10 : signal.price
  const previousYield = signal.previousClose > 20 ? signal.previousClose / 10 : signal.previousClose
  return currentYield - previousYield
}

function parseQuoteCoverage(value: string): { received: number; total: number; ratio: number } {
  const match = value.match(/(\d+)\s*\/\s*(\d+)/)
  const received = match ? Number(match[1]) : 0
  const total = match ? Number(match[2]) : 0
  return {
    received,
    total,
    ratio: total > 0 ? received / total : 0,
  }
}

function createPaperAccount(): PaperAccountState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    initialCapital: PAPER_INITIAL_CAPITAL,
    cash: PAPER_INITIAL_CAPITAL,
    realizedPnl: 0,
    maxEquity: PAPER_INITIAL_CAPITAL,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    riskState: createPaperRiskState(PAPER_INITIAL_CAPITAL),
    agentCredibility: { ...DEFAULT_AGENT_CREDIBILITY },
    postMortems: [],
    positions: [],
    journal: [
      {
        time: isoMinute(),
        ticker: 'SYSTEM',
        action: 'RESET',
        note: '$1000 paper account initialized. No real brokerage orders are placed.',
      },
    ],
  }
}

function normalizePaperAccount(value: Partial<PaperAccountState> | null | undefined): PaperAccountState {
  const fresh = createPaperAccount()
  const normalized: PaperAccountState = {
    ...fresh,
    ...(value || {}),
    version: 1 as const,
    initialCapital: Number(value?.initialCapital || fresh.initialCapital),
    cash: Number.isFinite(value?.cash) ? Number(value!.cash) : fresh.cash,
    realizedPnl: Number.isFinite(value?.realizedPnl) ? Number(value!.realizedPnl) : fresh.realizedPnl,
    maxEquity: Number.isFinite(value?.maxEquity) ? Number(value!.maxEquity) : fresh.maxEquity,
    tradeCount: Number.isFinite(value?.tradeCount) ? Number(value!.tradeCount) : fresh.tradeCount,
    wins: Number.isFinite(value?.wins) ? Number(value!.wins) : fresh.wins,
    losses: Number.isFinite(value?.losses) ? Number(value!.losses) : fresh.losses,
    grossProfit: Number.isFinite(value?.grossProfit) ? Number(value!.grossProfit) : fresh.grossProfit,
    grossLoss: Number.isFinite(value?.grossLoss) ? Number(value!.grossLoss) : fresh.grossLoss,
    agentCredibility: normalizeAgentCredibility(value?.agentCredibility),
    postMortems: Array.isArray(value?.postMortems) ? value!.postMortems.slice(-50) : fresh.postMortems,
    positions: Array.isArray(value?.positions) ? value!.positions : fresh.positions,
    journal: Array.isArray(value?.journal) ? value!.journal : fresh.journal,
  }
  normalized.riskState = normalizePaperRiskState(value?.riskState, paperEquity(normalized))
  return normalized
}

function paperStatePath(): string {
  return resolve(resolveKnowledgeRoot(), 'trading-journal', 'quant-lab-paper-state.json')
}

function readPaperAccount(): PaperAccountState {
  const targetPath = paperStatePath()
  if (!existsSync(targetPath)) return createPaperAccount()

  try {
    return normalizePaperAccount(JSON.parse(readFileSync(targetPath, 'utf-8')))
  } catch {
    return createPaperAccount()
  }
}

async function writePaperAccount(state: PaperAccountState): Promise<string> {
  const targetPath = paperStatePath()
  await mkdir(resolve(targetPath, '..'), { recursive: true })
  await saveUnsavedPaperPostMortems(state)
  await writeFile(targetPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  return targetPath
}

function normalizeAgentCredibility(value: Partial<AgentCredibilityScores> | null | undefined): AgentCredibilityScores {
  return {
    quant: clampAgentScore(value?.quant, DEFAULT_AGENT_CREDIBILITY.quant),
    bull: clampAgentScore(value?.bull, DEFAULT_AGENT_CREDIBILITY.bull),
    bear: clampAgentScore(value?.bear, DEFAULT_AGENT_CREDIBILITY.bear),
  }
}

function clampAgentScore(value: number | undefined, fallback: number): number {
  const numeric = Number.isFinite(value) ? Number(value) : fallback
  return Math.min(100, Math.max(0, numeric))
}

async function saveUnsavedPaperPostMortems(state: PaperAccountState): Promise<void> {
  if (!state.postMortems.length) return

  const root = resolveKnowledgeRoot()
  const targetDir = resolve(root, 'trading-journal', 'post-mortems')
  await mkdir(targetDir, { recursive: true })

  for (const report of state.postMortems) {
    if (report.relativePath) continue
    const fileName = safeMarkdownFileName(`${report.closedAt.slice(0, 10)}-${report.ticker}-${report.id}.md`)
    const targetPath = resolve(targetDir, fileName)
    if (!targetPath.startsWith(targetDir)) continue
    await writeFile(targetPath, report.markdown.endsWith('\n') ? report.markdown : `${report.markdown}\n`, 'utf-8')
    report.path = targetPath
    report.relativePath = targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath
  }
}

function positionValue(position: PaperPosition): number {
  return position.shares * position.lastPrice
}

function positionCost(position: PaperPosition): number {
  return position.shares * position.avgCost
}

function positionPnlPct(position: PaperPosition): number {
  const cost = positionCost(position)
  return cost > 0 ? ((positionValue(position) - cost) / cost) * 100 : 0
}

function paperEquity(state: PaperAccountState): number {
  return state.cash + state.positions.reduce((sum, position) => sum + positionValue(position), 0)
}

function paperReturnPct(state: PaperAccountState): number {
  return ((paperEquity(state) - state.initialCapital) / state.initialCapital) * 100
}

function paperDrawdownPct(state: PaperAccountState): number {
  const highWater = Math.max(state.maxEquity, paperEquity(state), state.initialCapital)
  return ((paperEquity(state) - highWater) / highWater) * 100
}

function paperWinRate(state: PaperAccountState): number {
  const completed = state.wins + state.losses
  return completed > 0 ? (state.wins / completed) * 100 : 0
}

function paperProfitFactor(state: PaperAccountState): number {
  if (state.grossLoss > 0) return state.grossProfit / state.grossLoss
  return state.grossProfit > 0 ? Number.POSITIVE_INFINITY : 0
}

function ensurePaperRiskState(state: PaperAccountState): PaperRiskState {
  const today = todayKey()
  if (!state.riskState) state.riskState = createPaperRiskState(paperEquity(state))

  if (state.riskState.tradingDate !== today) {
    const expiredPause = state.riskState.pauseNewBuysUntil && state.riskState.pauseNewBuysUntil <= today
    state.riskState = {
      ...state.riskState,
      tradingDate: today,
      dayStartEquity: paperEquity(state),
      buysToday: {},
      consecutiveLosses: expiredPause ? 0 : state.riskState.consecutiveLosses,
      pauseNewBuysUntil: expiredPause ? undefined : state.riskState.pauseNewBuysUntil,
    }
  }

  if (!state.riskState.buysToday || typeof state.riskState.buysToday !== 'object') state.riskState.buysToday = {}
  if (!Number.isFinite(state.riskState.dayStartEquity) || state.riskState.dayStartEquity <= 0) state.riskState.dayStartEquity = paperEquity(state)
  return state.riskState
}

function paperDailyReturnPct(state: PaperAccountState): number {
  const riskState = ensurePaperRiskState(state)
  return riskState.dayStartEquity > 0 ? ((paperEquity(state) - riskState.dayStartEquity) / riskState.dayStartEquity) * 100 : 0
}

function paperGuardrailStatus(state: PaperAccountState): { status: 'OK' | 'BLOCKED'; reason: string } {
  const riskState = ensurePaperRiskState(state)
  const today = todayKey()
  if (riskState.pauseNewBuysUntil && riskState.pauseNewBuysUntil > today) {
    return { status: 'BLOCKED', reason: `Paused after ${riskState.consecutiveLosses} consecutive realized losses until ${riskState.pauseNewBuysUntil}.` }
  }
  if (paperDailyReturnPct(state) <= PAPER_MAX_DAILY_LOSS_PCT) {
    return { status: 'BLOCKED', reason: `Daily loss guard reached ${paperDailyReturnPct(state).toFixed(2)}%.` }
  }
  if (paperDrawdownPct(state) <= PAPER_MAX_DRAWDOWN_PCT) {
    return { status: 'BLOCKED', reason: `Portfolio drawdown guard reached ${paperDrawdownPct(state).toFixed(2)}%.` }
  }
  return { status: 'OK', reason: 'New paper buys allowed within sizing rules.' }
}

function riskCheck(
  key: string,
  label: string,
  status: QuantRiskCheckStatus,
  value: string,
  reason: string,
  blocksNewBuys = status === 'BLOCK'
): QuantRiskCheck {
  return { key, label, status, value, reason, blocksNewBuys }
}

function evaluateTradingRisk(state: PaperAccountState, snapshot?: QuantLabSnapshot | null): QuantRiskEvaluation {
  const checks: QuantRiskCheck[] = []
  const guard = paperGuardrailStatus(state)
  const rawDailyReturn = paperDailyReturnPct(state)
  const rawDrawdown = paperDrawdownPct(state)
  const dailyReturn = Math.abs(rawDailyReturn) < 0.005 ? 0 : rawDailyReturn
  const drawdown = Math.abs(rawDrawdown) < 0.005 ? 0 : rawDrawdown
  const equity = Math.max(paperEquity(state), 1)
  const largestPosition = state.positions.reduce((max, position) => Math.max(max, positionValue(position)), 0)
  const largestWeight = (largestPosition / equity) * 100
  const worstStop = state.positions.reduce((worst, position) => Math.min(worst, positionPnlPct(position)), 0)

  checks.push(riskCheck(
    'account-guard',
    'Account',
    guard.status === 'BLOCKED' ? 'BLOCK' : 'PASS',
    guard.status,
    guard.reason
  ))
  checks.push(riskCheck(
    'daily-loss',
    'Daily',
    dailyReturn <= PAPER_MAX_DAILY_LOSS_PCT ? 'BLOCK' : dailyReturn < 0 ? 'WARN' : 'PASS',
    `${dailyReturn.toFixed(2)}% / ${PAPER_MAX_DAILY_LOSS_PCT}%`,
    dailyReturn <= PAPER_MAX_DAILY_LOSS_PCT
      ? 'Daily loss limit reached; new paper buys are prohibited.'
      : dailyReturn < 0
        ? 'Daily P/L is negative; reduce size and require stronger confirmation.'
        : 'Daily loss guard is clear.'
  ))
  checks.push(riskCheck(
    'drawdown',
    'Drawdown',
    drawdown <= PAPER_MAX_DRAWDOWN_PCT ? 'BLOCK' : drawdown <= PAPER_MAX_DRAWDOWN_PCT / 2 ? 'WARN' : 'PASS',
    `${drawdown.toFixed(2)}% / ${PAPER_MAX_DRAWDOWN_PCT}%`,
    drawdown <= PAPER_MAX_DRAWDOWN_PCT
      ? 'Maximum drawdown guard reached; new paper buys are prohibited.'
      : drawdown <= PAPER_MAX_DRAWDOWN_PCT / 2
        ? 'Drawdown is elevated; only strongest setups should be considered.'
        : 'Drawdown guard is clear.'
  ))
  checks.push(riskCheck(
    'positions',
    'Positions',
    state.positions.length >= PAPER_MAX_POSITIONS ? 'BLOCK' : state.positions.length >= PAPER_MAX_POSITIONS - 1 ? 'WARN' : 'PASS',
    `${state.positions.length}/${PAPER_MAX_POSITIONS}`,
    state.positions.length >= PAPER_MAX_POSITIONS
      ? 'Maximum open paper positions reached; new paper buys are prohibited.'
      : state.positions.length >= PAPER_MAX_POSITIONS - 1
        ? 'Position count is near the maximum.'
        : 'Position count is within limits.'
  ))
  checks.push(riskCheck(
    'single-name-cap',
    'Single Cap',
    largestPosition >= PAPER_MAX_SINGLE_ALLOCATION ? 'BLOCK' : largestPosition >= PAPER_MAX_SINGLE_ALLOCATION * 0.9 ? 'WARN' : 'PASS',
    `${formatMoney(largestPosition)} / ${formatMoney(PAPER_MAX_SINGLE_ALLOCATION)} (${largestWeight.toFixed(1)}%)`,
    largestPosition >= PAPER_MAX_SINGLE_ALLOCATION
      ? 'At least one paper position is at the single-name cap; that ticker cannot be increased.'
      : largestPosition >= PAPER_MAX_SINGLE_ALLOCATION * 0.9
        ? 'Largest paper position is close to the single-name cap.'
        : 'Single-name exposure is within limits.',
    false
  ))
  checks.push(riskCheck(
    'stop-loss',
    'Stop Loss',
    worstStop <= PAPER_STOP_LOSS_PCT ? 'BLOCK' : worstStop <= PAPER_STOP_WARN_PCT ? 'WARN' : 'PASS',
    state.positions.length ? `${worstStop.toFixed(2)}% / ${PAPER_STOP_LOSS_PCT}%` : 'none',
    worstStop <= PAPER_STOP_LOSS_PCT
      ? 'A paper position has crossed the stop-loss threshold; no new buys until it is handled.'
      : worstStop <= PAPER_STOP_WARN_PCT
        ? 'A paper position is nearing the stop-loss threshold.'
        : 'No paper position is near stop-loss.'
  ))

  if (snapshot) {
    const coverage = parseQuoteCoverage(snapshot.dataHealth.quoteCoverage)
    const quoteStatus = snapshot.dataHealth.status || 'OK'
    const nonAcceptedFallback = (snapshot.dataHealth.fallbackSymbols || [])
      .some(symbol => !ACCEPTED_MACRO_FALLBACK_SYMBOLS.has(symbol))
    const dataBlocked = quoteStatus === 'ERROR' ||
      quoteStatus === 'FALLBACK' ||
      snapshot.source.includes('mock') ||
      snapshot.dataHealth.quoteSource.includes('mock') ||
      coverage.received === 0
    const dataWarn = quoteStatus === 'DEGRADED' ||
      nonAcceptedFallback ||
      (coverage.total > 0 && coverage.ratio < 0.9)

    checks.push(riskCheck(
      'data-health',
      'Data',
      dataBlocked ? 'BLOCK' : dataWarn ? 'WARN' : 'PASS',
      `${quoteStatus} ${snapshot.dataHealth.quoteCoverage}`,
      dataBlocked
        ? 'Quote source is fallback/error/mock; AI may only discuss, not create paper buys.'
        : dataWarn
          ? 'Quote source is degraded; require manual confirmation before trusting signals.'
          : 'Quote coverage is usable for paper decisions.'
    ))
    checks.push(riskCheck(
      'paper-price-source',
      'Paper Price',
      hasUsablePaperQuotes(snapshot) ? 'PASS' : 'BLOCK',
      snapshot.dataHealth.quoteSource,
      hasUsablePaperQuotes(snapshot)
        ? 'Paper buys can use a trusted Alpaca/Polygon quote source.'
        : 'Paper buys are disabled because the current quote source is mock, delayed, fallback, or unavailable. Analysis and journaling remain available.'
    ))

    const vixSignal = getDailySignal(snapshot, '^VIX')
    const vixNumbers = parsePulseNumbers(snapshot, 'VIX')
    const vixPrice = vixSignal?.price ?? vixNumbers[0] ?? null
    const vixChangePct = vixSignal?.changePercent ?? vixNumbers[1] ?? null
    const vixMomentum20 = vixSignal?.momentum20 ?? null
    const vixBlocked = (vixPrice !== null && vixPrice >= PAPER_VIX_BLOCK) ||
      (vixChangePct !== null && vixChangePct >= PAPER_VIX_SPIKE_PCT) ||
      (vixMomentum20 !== null && vixMomentum20 >= 18)
    const vixWarn = (vixPrice !== null && vixPrice >= PAPER_VIX_WARN) ||
      (vixChangePct !== null && vixChangePct > 0) ||
      (vixMomentum20 !== null && vixMomentum20 > 8)
    checks.push(riskCheck(
      'vix-spike',
      'VIX',
      vixBlocked ? 'BLOCK' : vixWarn ? 'WARN' : 'PASS',
      vixSignal
        ? `${vixPrice?.toFixed(1) ?? 'n/a'} ${dailySignalPercent(vixChangePct)} / 20D ${dailySignalPercent(vixMomentum20)} / ${vixSignal.consecutiveUpDays}d up`
        : getPulseValue(snapshot, 'VIX'),
      vixBlocked
        ? 'VIX daily stress condition active; new paper buys are prohibited.'
        : vixWarn
          ? 'VIX is rising or elevated on daily data; require smaller size and better confirmation.'
          : 'VIX daily guard is clear.'
    ))

    const qqqSignal = getDailySignal(snapshot, 'QQQ')
    if (qqqSignal) {
      const below20 = isNumber(qqqSignal.ma20DistancePct) && qqqSignal.ma20DistancePct < 0
      const below60 = isNumber(qqqSignal.ma60DistancePct) && qqqSignal.ma60DistancePct < 0
      const weak20 = isNumber(qqqSignal.momentum20) && qqqSignal.momentum20 < -2
      const qqqBlocked = below20 && (below60 || weak20)
      const qqqWarn = below20 || below60 || weak20
      checks.push(riskCheck(
        'qqq-trend',
        'QQQ 20/60',
        qqqBlocked ? 'BLOCK' : qqqWarn ? 'WARN' : 'PASS',
        `20MA ${dailySignalPercent(qqqSignal.ma20DistancePct)} / 60MA ${dailySignalPercent(qqqSignal.ma60DistancePct)} / 20D ${dailySignalPercent(qqqSignal.momentum20)}`,
        qqqBlocked
          ? 'QQQ is below the daily 20MA and has weak 20/60 confirmation; new paper buys are prohibited.'
          : qqqWarn
            ? 'QQQ daily trend is not fully confirmed; require smaller size and better confirmation.'
            : 'QQQ daily 20/60 trend guard is clear.',
        qqqBlocked
      ))
    } else {
      const summaryText = snapshot.backtestSummary.join(' ').toLowerCase()
      const qqqCash = summaryText.includes('qqq 20/60 cash')
      const qqqActive = summaryText.includes('qqq 20/60 active')
      checks.push(riskCheck(
        'qqq-trend',
        'QQQ 20/60',
        qqqCash ? 'BLOCK' : qqqActive ? 'PASS' : 'WARN',
        qqqCash ? 'cash' : qqqActive ? 'active' : 'unknown',
        qqqCash
          ? 'QQQ is below the 20/60 momentum filter; new paper buys are prohibited.'
          : qqqActive
            ? 'QQQ momentum filter is active.'
            : 'QQQ daily signal is unavailable; do not treat trend as confirmed.',
        qqqCash
      ))
    }

    const tenYearSignal = getDailySignal(snapshot, '^TNX')
    const tenYearNumbers = parsePulseNumbers(snapshot, '10Y')
    const tenYearYield = tenYearSignal
      ? (tenYearSignal.price > 20 ? tenYearSignal.price / 10 : tenYearSignal.price)
      : tenYearNumbers[0] ?? null
    const tenYearChange = dailyYieldChange(tenYearSignal) ?? tenYearNumbers[1] ?? null
    const tenYearMomentum20 = tenYearSignal?.momentum20 ?? null
    const tenYearBlocked = (tenYearYield !== null && tenYearYield >= PAPER_10Y_BLOCK_YIELD) ||
      (tenYearChange !== null && tenYearChange >= PAPER_10Y_BLOCK_CHANGE) ||
      (tenYearSignal !== null && tenYearSignal.consecutiveUpDays >= 3 && (tenYearMomentum20 ?? 0) > 1.5)
    const tenYearWarn = (tenYearYield !== null && tenYearYield >= PAPER_10Y_WARN_YIELD) ||
      (tenYearChange !== null && tenYearChange >= PAPER_10Y_WARN_CHANGE) ||
      (tenYearSignal !== null && tenYearSignal.consecutiveUpDays >= 2)
    checks.push(riskCheck(
      'ten-year-rise',
      '10Y',
      tenYearBlocked ? 'BLOCK' : tenYearWarn ? 'WARN' : 'PASS',
      tenYearSignal
        ? `${tenYearYield?.toFixed(2) ?? 'n/a'}% ${formatSignedNumber(tenYearChange)} / 20D ${dailySignalPercent(tenYearMomentum20)} / ${tenYearSignal.consecutiveUpDays}d up`
        : getPulseValue(snapshot, '10Y'),
      tenYearBlocked
        ? '10Y daily yield pressure is too high or rising too fast; new paper buys are prohibited.'
        : tenYearWarn
          ? '10Y daily yield pressure is elevated.'
          : '10Y daily guard is clear.'
    ))

    const backtestFallback = snapshot.dataHealth.backtestSource.includes('mock')
    checks.push(riskCheck(
      'backtest-health',
      'Backtest',
      backtestFallback ? 'WARN' : 'PASS',
      snapshot.dataHealth.backtestSource,
      backtestFallback
        ? 'Backtest source is fallback; strategy statistics are not fully verified.'
        : 'Backtest source is available.',
      false
    ))
  } else {
    checks.push(riskCheck(
      'data-health',
      'Data',
      'WARN',
      'snapshot unavailable',
      'Snapshot was not supplied; market-level risk checks are not confirmed.',
      false
    ))
  }

  checks.push(riskCheck(
    'ai-authority',
    'AI Authority',
    'PASS',
    'suggest-only',
    'AI actions are advisory and audited; server guardrails decide whether paper buys can execute.',
    false
  ))

  const hardBlocks = checks.filter(check => check.status === 'BLOCK' && check.blocksNewBuys !== false)
  const warns = checks.filter(check => check.status === 'WARN')
  return {
    status: hardBlocks.length ? 'BLOCKED' : 'OK',
    reason: hardBlocks[0]?.reason || warns[0]?.reason || 'Phase 4 risk controls allow new paper buys within sizing rules.',
    prohibited: hardBlocks.map(check => `${check.label}: ${check.reason}`),
    checks,
    generatedAt: new Date().toISOString(),
  }
}

function canOpenPaperBuy(state: PaperAccountState, pick: QuantLabSnapshot['topPicks'][number], snapshot?: QuantLabSnapshot | null): { ok: boolean; reason: string } {
  const riskState = ensurePaperRiskState(state)
  const valuation = 'scoreBreakdown' in pick ? pick.scoreBreakdown?.valuation : undefined
  if (valuation?.maxAction && valuation.maxAction !== 'BUY') {
    const tier = valuation.riskTier || 'unknown'
    const warning = valuation.warning ? ` ${valuation.warning}.` : ''
    const cap = Number.isFinite(valuation.scoreCap) ? ` Cap ${Number(valuation.scoreCap).toFixed(2)}.` : ''
    return {
      ok: false,
      reason: `Valuation guard blocks ${pick.ticker} paper BUY: maxAction ${valuation.maxAction}, tier ${tier}.${cap}${warning}`,
    }
  }
  const risk = evaluateTradingRisk(state, snapshot)
  if (risk.status === 'BLOCKED') return { ok: false, reason: risk.reason }
  if (riskState.buysToday[pick.ticker]) return { ok: false, reason: `${pick.ticker} already bought today at ${riskState.buysToday[pick.ticker]}.` }
  if (snapshot && !findPaperPrice(snapshot, pick.ticker)) {
    return {
      ok: false,
      reason: `${pick.ticker} has no trusted real-time paper price. Source ${snapshot.dataHealth.quoteSource}; paper buys stay analysis-only until Alpaca/Polygon live quote is usable.`,
    }
  }

  const existing = state.positions.find(position => position.ticker === pick.ticker)
  if (!existing && state.positions.length >= PAPER_MAX_POSITIONS) return { ok: false, reason: `Max ${PAPER_MAX_POSITIONS} open positions reached.` }
  if (existing && positionValue(existing) >= PAPER_MAX_SINGLE_ALLOCATION) return { ok: false, reason: `${pick.ticker} already at single-name cap ${formatMoney(PAPER_MAX_SINGLE_ALLOCATION)}.` }
  if (state.cash < PAPER_MIN_TRADE_AMOUNT) return { ok: false, reason: `Cash below minimum paper trade amount ${formatMoney(PAPER_MIN_TRADE_AMOUNT)}.` }
  if (pick.price <= 0) return { ok: false, reason: 'Invalid quote price.' }
  return { ok: true, reason: 'Allowed.' }
}

function evaluateSynthesisAutoBuyGate(snapshot: QuantLabSnapshot): { ok: boolean; reason: string } {
  const decision = snapshot.decision as QuantLabSnapshot['decision'] & {
    expectedScore?: number | null
    macroRisk?: number | null
    riskMultiplier?: number | null
    macroRegime?: string | null
    synthesisAction?: string | null
  }
  const synthesisAction = decision.synthesisAction
  if (synthesisAction && synthesisAction !== 'BUY') {
    return { ok: false, reason: `Phase 5 synthesis is ${synthesisAction}; automatic paper buys require BUY.` }
  }

  if (Number.isFinite(decision.expectedScore) && Number(decision.expectedScore) < 85) {
    return { ok: false, reason: `Phase 5 expected score ${Number(decision.expectedScore).toFixed(2)} is below the automatic buy threshold 85.` }
  }
  if (Number.isFinite(decision.macroRisk) && Number(decision.macroRisk) >= 50) {
    return { ok: false, reason: `Macro risk ${Number(decision.macroRisk).toFixed(2)} is too high for automatic paper buys.` }
  }
  if (Number.isFinite(decision.riskMultiplier) && Number(decision.riskMultiplier) < 0.5) {
    return { ok: false, reason: `MiroFish Macro Agent risk multiplier ${Number(decision.riskMultiplier).toFixed(2)} is below 0.50.` }
  }

  const debate = snapshot.mirofishInference?.debate
  const bearishProbability = debate?.scenarios?.bearish?.probability
  if (Number.isFinite(bearishProbability) && Number(bearishProbability) >= 0.6) {
    return { ok: false, reason: `MiroFish bearish scenario probability ${Number(bearishProbability).toFixed(2)} is at or above 0.60.` }
  }

  const macroRegime = debate?.macro?.Regime || decision.macroRegime
  if (macroRegime === 'Risk-Off') {
    return { ok: false, reason: 'MiroFish Macro Agent classified the regime as Risk-Off.' }
  }

  return { ok: true, reason: 'Phase 5 / MiroFish gate allows automatic paper buy evaluation.' }
}

function addPaperJournal(state: PaperAccountState, ticker: string, action: PaperJournalAction, note: string): void {
  state.journal.unshift({
    time: isoMinute(),
    ticker,
    action,
    note: redactSensitiveText(note),
  })
  state.journal = state.journal.slice(0, 100)
}

function buildHistoricalTradeSeed(
  state: PaperAccountState,
  pick: QuantLabSnapshot['topPicks'][number],
  snapshot?: QuantLabSnapshot | null
): AgentHistoricalSeed {
  const breakdown = (pick as typeof pick & { scoreBreakdown?: { source?: string } }).scoreBreakdown
  const debate = snapshot?.mirofishInference?.debate
  const decision = snapshot?.decision as (QuantLabSnapshot['decision'] & { expectedScore?: number | null }) | undefined
  return {
    ticker: pick.ticker,
    createdAt: new Date().toISOString(),
    quantScore: pick.score,
    quantAction: pick.action,
    quantReason: pick.reason,
    quantSource: breakdown?.source || snapshot?.dataHealth.quoteSource || snapshot?.source || 'unknown',
    mirofish: debate ? {
      bullishProbability: debate.scenarios.bullish.probability,
      bullishConfidence: debate.scenarios.bullish.confidence,
      bullishReasoning: debate.scenarios.bullish.reasoning,
      bearishProbability: debate.scenarios.bearish.probability,
      bearishConfidence: debate.scenarios.bearish.confidence,
      bearishReasoning: debate.scenarios.bearish.reasoning,
      neutralProbability: debate.scenarios.neutral.probability,
      neutralConfidence: debate.scenarios.neutral.confidence,
    } : null,
    seedRelativePath: snapshot?.mirofishSeed?.relativePath,
    reportRelativePath: snapshot?.mirofishInference?.reportRelativePath,
    inferenceStatus: snapshot?.mirofishInference?.status,
    decisionExpectedScore: decision?.expectedScore ?? null,
    credibilityBefore: state.agentCredibility,
  }
}

function fallbackHistoricalTradeSeed(state: PaperAccountState, position: PaperPosition): AgentHistoricalSeed {
  return {
    ticker: position.ticker,
    createdAt: position.openedAt || state.updatedAt,
    quantScore: 0,
    quantAction: 'UNKNOWN',
    quantReason: 'Entry seed was not available for this legacy paper position.',
    quantSource: 'legacy-paper-position',
    mirofish: null,
    credibilityBefore: state.agentCredibility,
  }
}

function recordTradePostMortem(
  state: PaperAccountState,
  position: PaperPosition,
  closedTrade: {
    pnl: number
    pnlPct: number
    exitPrice: number
    note: string
  }
): AgentEvaluationResult {
  const closedAt = new Date().toISOString()
  const evaluation = evaluateTrade(
    {
      ticker: position.ticker,
      pnl: closedTrade.pnl,
      pnlPct: closedTrade.pnlPct,
      shares: position.shares,
      entryPrice: position.avgCost,
      exitPrice: closedTrade.exitPrice,
      openedAt: position.openedAt,
      closedAt,
      note: closedTrade.note,
    },
    position.entrySeed || fallbackHistoricalTradeSeed(state, position),
    state.agentCredibility
  )

  state.agentCredibility = evaluation.updatedCredibility
  state.postMortems.unshift({
    id: evaluation.id,
    ticker: evaluation.ticker,
    openedAt: position.openedAt,
    closedAt,
    result: evaluation.result,
    pnl: evaluation.pnl,
    pnlPct: evaluation.pnlPct,
    shares: position.shares,
    entryPrice: position.avgCost,
    exitPrice: closedTrade.exitPrice,
    markdown: evaluation.markdown,
    scoreDeltas: {
      quant: evaluation.quantContribution.delta,
      bull: evaluation.bullPrediction.delta,
      bear: evaluation.bearWarning.delta,
    },
    updatedCredibility: evaluation.updatedCredibility,
  })
  state.postMortems = state.postMortems.slice(0, 50)
  return evaluation
}

function paperPriceBook(snapshot: QuantLabSnapshot): PaperPriceBookItem[] {
  const raw = (snapshot as QuantLabSnapshot & { priceBook?: PaperPriceBookItem[] }).priceBook
  return Array.isArray(raw) ? raw : []
}

function hasUsablePaperQuotes(snapshot: QuantLabSnapshot): boolean {
  return snapshotHasTrustedEquitySource(snapshot)
}

function findPaperPrice(snapshot: QuantLabSnapshot, ticker: string): PaperPriceBookItem | null {
  if (!hasUsablePaperQuotes(snapshot)) return null

  const key = ticker.trim().toUpperCase()
  const priceBookItem = paperPriceBook(snapshot).find(item => item.ticker === key)
  if (
    priceBookItem &&
    priceBookItem.source !== 'fallback-price' &&
    Number.isFinite(priceBookItem.price) &&
    priceBookItem.price > 0
  ) return priceBookItem

  const pick = snapshot.topPicks.find(item => item.ticker === key)
  const pickSource = (pick as (typeof pick & { scoreBreakdown?: { source?: string } }) | undefined)?.scoreBreakdown?.source
  if (pick && pickSource !== 'fallback-price' && Number.isFinite(pick.price) && pick.price > 0) {
    return {
      ticker: pick.ticker,
      price: pick.price,
      trend: pick.trend,
      source: 'top-pick-price',
      quoteSource: snapshot.dataHealth.quoteSource,
      updatedAt: snapshot.dataHealth.updatedAt,
    }
  }

  return null
}

function markPaperToMarket(state: PaperAccountState, snapshot: QuantLabSnapshot): { updated: string[]; missing: string[] } {
  const updated: string[] = []
  const missing: string[] = []

  for (const position of state.positions) {
    const price = findPaperPrice(snapshot, position.ticker)
    if (!price) {
      missing.push(position.ticker)
      continue
    }
    position.lastPrice = price.price
    updated.push(position.ticker)
  }
  state.maxEquity = Math.max(state.maxEquity, paperEquity(state))
  return { updated, missing }
}

function sellPaperPosition(state: PaperAccountState, ticker: string, note: string, auditContext = ''): PaperTradeExecutionEvent | null {
  const riskState = ensurePaperRiskState(state)
  const index = state.positions.findIndex(position => position.ticker === ticker)
  if (index < 0) return null

  const position = state.positions[index]
  const execution = applyPessimisticExecution({ side: 'SELL', marketPrice: position.lastPrice })
  const value = position.shares * execution.executionPrice
  const pnl = value - positionCost(position)
  const pnlPct = positionCost(position) > 0 ? (pnl / positionCost(position)) * 100 : 0
  const postMortem = recordTradePostMortem(state, position, {
    pnl,
    pnlPct,
    exitPrice: execution.executionPrice,
    note,
  })
  state.positions.splice(index, 1)
  state.cash += value
  state.realizedPnl += pnl
  state.tradeCount += 1
  if (pnl >= 0) {
    state.wins += 1
    state.grossProfit += pnl
    riskState.consecutiveLosses = 0
    riskState.pauseNewBuysUntil = undefined
  } else {
    state.losses += 1
    state.grossLoss += Math.abs(pnl)
    riskState.consecutiveLosses += 1
    if (riskState.consecutiveLosses >= PAPER_MAX_CONSECUTIVE_LOSSES) {
      riskState.pauseNewBuysUntil = nextDateKey()
      riskState.lastGuardrail = `Paused new paper buys until ${riskState.pauseNewBuysUntil} after ${riskState.consecutiveLosses} consecutive losses.`
    }
  }
  addPaperJournal(
    state,
    ticker,
    'SELL',
    `${note} Realized P/L ${formatMoney(pnl)} (${pnlPct.toFixed(2)}%). Execution ${formatMoney(execution.executionPrice)} vs market ${formatMoney(execution.marketPrice)} after ${(execution.slippageRate * 100).toFixed(2)}% slippage. Post-mortem ${postMortem.result}: Quant ${formatSignedNumber(postMortem.quantContribution.delta)}, Bull ${formatSignedNumber(postMortem.bullPrediction.delta)}, Bear ${formatSignedNumber(postMortem.bearWarning.delta)}.${auditContext ? ` Audit: ${auditContext}.` : ''} Next check: verify whether the original thesis failed or only needs a smaller watchlist position.` +
      (riskState.pauseNewBuysUntil ? ` ${riskState.lastGuardrail}` : '')
  )
  return {
    ticker,
    side: 'SELL',
    marketPrice: execution.marketPrice,
    executionPrice: execution.executionPrice,
    slippageRate: execution.slippageRate,
    shares: position.shares,
    grossValue: value,
    pnl,
    pnlPct,
    note,
    source: auditContext || 'paper-account',
  }
}

function buyPaperPick(state: PaperAccountState, pick: QuantLabSnapshot['topPicks'][number], snapshot?: QuantLabSnapshot | null): PaperTradeExecutionEvent | null {
  const allowed = canOpenPaperBuy(state, pick, snapshot)
  if (!allowed.ok) {
    state.riskState.lastGuardrail = allowed.reason
    addPaperJournal(state, pick.ticker, 'WATCH', `Paper buy blocked: ${allowed.reason} Why not buy: ${pick.reason}; score ${pick.score}; risk ${pick.risk}.`)
    return null
  }
  const preTradeRisk = evaluateTradingRisk(state, snapshot)

  const trustedPrice = snapshot ? findPaperPrice(snapshot, pick.ticker) : null
  const marketPrice = trustedPrice?.price || pick.price
  const execution = applyPessimisticExecution({ side: 'BUY', marketPrice })
  const paperPrice = execution.executionPrice
  const entrySeed = buildHistoricalTradeSeed(state, pick, snapshot)
  const priceAudit = trustedPrice
    ? `source ${trustedPrice.quoteSource}/${trustedPrice.source}; updated ${trustedPrice.updatedAt}`
    : 'source unavailable; used candidate price'
  const existing = state.positions.find(position => position.ticker === pick.ticker)
  if (!existing && state.positions.length >= PAPER_MAX_POSITIONS) return null

  const currentValue = existing ? positionValue(existing) : 0
  const room = Math.max(0, PAPER_MAX_SINGLE_ALLOCATION - currentValue)
  const amount = Math.min(state.cash, room, PAPER_MAX_SINGLE_ALLOCATION)
  if (amount < PAPER_MIN_TRADE_AMOUNT || marketPrice <= 0 || paperPrice <= 0) {
    const reason = amount < PAPER_MIN_TRADE_AMOUNT
      ? `Allocation room ${formatMoney(amount)} is below minimum trade ${formatMoney(PAPER_MIN_TRADE_AMOUNT)}.`
      : 'Invalid quote price.'
    state.riskState.lastGuardrail = reason
    addPaperJournal(state, pick.ticker, 'WATCH', `Paper buy blocked: ${reason}`)
    return null
  }

  const shares = amount / paperPrice
  if (existing) {
    const oldCost = positionCost(existing)
    existing.avgCost = (oldCost + amount) / (existing.shares + shares)
    existing.shares += shares
    existing.lastPrice = marketPrice
    existing.openedAt ||= entrySeed.createdAt
    existing.entrySeed = entrySeed
  } else {
    state.positions.push({
      ticker: pick.ticker,
      shares,
      avgCost: paperPrice,
      lastPrice: marketPrice,
      stop: pick.risk === 'H' ? 'half size / tight stop' : '20MA or risk score break',
      openedAt: entrySeed.createdAt,
      entrySeed,
    })
  }

  state.cash -= amount
  state.tradeCount += 1
  state.riskState.buysToday[pick.ticker] = isoMinute()
  state.riskState.lastGuardrail = undefined
  const postTradeRisk = evaluateTradingRisk(state, snapshot)
  addPaperJournal(
    state,
    pick.ticker,
    'BUY',
    `${formatMoney(amount)} paper buy at execution ${formatMoney(paperPrice)} vs market ${formatMoney(marketPrice)} after ${(execution.slippageRate * 100).toFixed(2)}% slippage. Audit: ${priceAudit}; Pre-Guard ${preTradeRisk.status}; Post-Guard ${postTradeRisk.status}; Score ${pick.score}; Thesis ${pick.reason}; Risk ${pick.risk}; Stop ${existing?.stop || (pick.risk === 'H' ? 'half size / tight stop' : '20MA or risk score break')}. Next check: confirm trend, volume, VIX, and 10Y next session.`
  )
  return {
    ticker: pick.ticker,
    side: 'BUY',
    marketPrice,
    executionPrice: paperPrice,
    slippageRate: execution.slippageRate,
    shares,
    grossValue: amount,
    score: pick.score,
    risk: pick.risk,
    note: pick.reason,
    source: priceAudit,
  }
}

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

function applyPaperStrategy(
  state: PaperAccountState,
  snapshot: QuantLabSnapshot,
  phase: QuantLabBriefPhase,
  executionEvents: PaperTradeExecutionEvent[] = []
): PaperAccountState {
  const mark = markPaperToMarket(state, snapshot)
  ensurePaperRiskState(state)
  const updatedTickers = new Set(mark.updated)

  for (const position of [...state.positions]) {
    const pnlPct = positionPnlPct(position)
    if (updatedTickers.has(position.ticker) && pnlPct <= PAPER_STOP_LOSS_PCT) {
      const event = sellPaperPosition(state, position.ticker, `Paper stop-loss guard triggered at ${pnlPct.toFixed(2)}%.`, `mark source ${snapshot.dataHealth.quoteSource}`)
      if (event) executionEvents.push(event)
    }
  }

  const vix = parsePulseNumber(snapshot, 'VIX') || 0
  const regime = getPulseValue(snapshot, 'Regime')
  const riskOff = vix >= 20 || regime === 'Risk-off' || paperDrawdownPct(state) <= PAPER_MAX_DRAWDOWN_PCT || paperDailyReturnPct(state) <= PAPER_MAX_DAILY_LOSS_PCT
  const risk = evaluateTradingRisk(state, snapshot)
  const pickByTicker = new Map(snapshot.topPicks.map(pick => [pick.ticker, pick]))

  if (riskOff) {
    for (const position of [...state.positions]) {
      const pick = pickByTicker.get(position.ticker)
      if (!pick || pick.risk === 'H' || pick.action !== 'BUY') {
        const event = sellPaperPosition(state, position.ticker, 'Risk-off paper exit.', `risk source ${snapshot.dataHealth.quoteSource}`)
        if (event) executionEvents.push(event)
      }
    }
    state.riskState.lastGuardrail = `Risk guard active: VIX ${vix.toFixed(1)}, regime ${regime}, daily P/L ${paperDailyReturnPct(state).toFixed(2)}%, drawdown ${paperDrawdownPct(state).toFixed(2)}%.`
    addPaperJournal(state, 'RISK', 'WATCH', `${state.riskState.lastGuardrail} No new paper buys.`)
  } else if (risk.status === 'BLOCKED') {
    state.riskState.lastGuardrail = risk.reason
    addPaperJournal(state, 'RISK', 'WATCH', `Phase 4 guard blocked new paper buys: ${risk.reason}`)
  } else if (phase === 'premarket') {
    const synthesisGate = evaluateSynthesisAutoBuyGate(snapshot)
    if (!synthesisGate.ok) {
      state.riskState.lastGuardrail = synthesisGate.reason
      addPaperJournal(state, 'SYNTHESIS', 'WATCH', `Phase 5 / MiroFish gate blocked new paper buys: ${synthesisGate.reason}`)
    } else {
      const candidates = snapshot.topPicks
        .filter(pick => pick.action === 'BUY' && pick.risk !== 'H' && pick.score >= 87)
        .slice(0, 2)

      for (const pick of candidates) {
        const event = buyPaperPick(state, pick, snapshot)
        if (event) executionEvents.push(event)
      }
      if (!candidates.length) addPaperJournal(state, 'SYSTEM', 'WATCH', 'No high-confidence paper buy candidate in this brief. Why not buy: score/action filters did not meet BUY + score >= 87 + non-H risk.')
    }
  } else {
    addPaperJournal(state, 'SYSTEM', 'MARK', 'After-close paper account marked to market; no new automatic buys after close. Next check: compare tomorrow open against today thesis and risk guards.')
  }

  state.maxEquity = Math.max(state.maxEquity, paperEquity(state))
  state.updatedAt = new Date().toISOString()
  return state
}

function paperSummaryRows(state: PaperAccountState, snapshot?: QuantLabSnapshot | null): string {
  const pf = paperProfitFactor(state)
  const guard = evaluateTradingRisk(state, snapshot)
  return [
    `| Equity | ${formatMoney(paperEquity(state))} |`,
    `| Cash | ${formatMoney(state.cash)} |`,
    `| Positions | ${formatMoney(state.positions.reduce((sum, item) => sum + positionValue(item), 0))} |`,
    `| P/L | ${paperReturnPct(state).toFixed(2)}% |`,
    `| Daily P/L | ${paperDailyReturnPct(state).toFixed(2)}% |`,
    `| Max DD | ${paperDrawdownPct(state).toFixed(2)}% |`,
    `| Win Rate | ${paperWinRate(state).toFixed(0)}% |`,
    `| Profit Factor | ${Number.isFinite(pf) ? pf.toFixed(2) : '∞'} |`,
    `| New Buy Guard | ${guard.status}: ${guard.reason.replace(/\|/g, '/')} |`,
    `| Consecutive Losses | ${ensurePaperRiskState(state).consecutiveLosses} |`,
  ].join('\n')
}

function paperPositionRows(state: PaperAccountState): string {
  if (!state.positions.length) return '| - | - | - | - | - | - |'

  return state.positions
    .map(position => {
      const value = positionValue(position)
      const cost = positionCost(position)
      const pnlPct = cost > 0 ? ((value - cost) / cost) * 100 : 0
      return `| ${position.ticker} | ${position.shares.toFixed(4)} | ${formatMoney(position.avgCost)} | ${formatMoney(position.lastPrice)} | ${formatMoney(value)} | ${pnlPct.toFixed(2)}% |`
    })
    .join('\n')
}

function paperJournalRows(state: PaperAccountState): string {
  return state.journal
    .slice(0, 12)
    .map(entry => `| ${entry.time} | ${entry.ticker} | ${entry.action} | ${entry.note.replace(/\|/g, '/')} |`)
    .join('\n')
}

function riskCheckRows(risk: QuantRiskEvaluation): string {
  return risk.checks
    .map(check => `| ${tableEscape(check.label)} | ${check.status} | ${tableEscape(check.value)} | ${tableEscape(check.reason)} |`)
    .join('\n')
}

function paperTelegramSummary(state: PaperAccountState, snapshot?: QuantLabSnapshot | null): string {
  const pf = paperProfitFactor(state)
  const guard = evaluateTradingRisk(state, snapshot)
  const positions = state.positions.length
    ? state.positions.map(position => `${position.ticker} ${formatMoney(positionValue(position))}`).join(', ')
    : 'none'

  return `Paper KPI:
Equity ${formatMoney(paperEquity(state))}
Cash ${formatMoney(state.cash)}
P/L ${paperReturnPct(state).toFixed(2)}%
Daily P/L ${paperDailyReturnPct(state).toFixed(2)}%
Max DD ${paperDrawdownPct(state).toFixed(2)}%
Win Rate ${paperWinRate(state).toFixed(0)}%
Profit Factor ${Number.isFinite(pf) ? pf.toFixed(2) : '∞'}
Guard ${guard.status}: ${guard.reason}
Positions: ${positions}`
}

function paperAccountResponse(paper: PaperAccountState, snapshot?: QuantLabSnapshot | null) {
  const riskState = ensurePaperRiskState(paper)
  const guard = evaluateTradingRisk(paper, snapshot)
  return {
    ...paper,
    equity: Number(paperEquity(paper).toFixed(2)),
    returnPct: Number(paperReturnPct(paper).toFixed(2)),
    dailyReturnPct: Number(paperDailyReturnPct(paper).toFixed(2)),
    maxDrawdownPct: Number(paperDrawdownPct(paper).toFixed(2)),
    winRate: Number(paperWinRate(paper).toFixed(2)),
    profitFactor: Number.isFinite(paperProfitFactor(paper)) ? Number(paperProfitFactor(paper).toFixed(2)) : null,
    guardrails: {
      tradingDate: riskState.tradingDate,
      dayStartEquity: Number(riskState.dayStartEquity.toFixed(2)),
      dailyReturnPct: Number(paperDailyReturnPct(paper).toFixed(2)),
      consecutiveLosses: riskState.consecutiveLosses,
      pauseNewBuysUntil: riskState.pauseNewBuysUntil || null,
      buysToday: riskState.buysToday,
      status: guard.status,
      reason: guard.reason,
      lastGuardrail: riskState.lastGuardrail || null,
      checks: guard.checks,
      prohibited: guard.prohibited,
      generatedAt: guard.generatedAt,
    },
    statePath: paperStatePath(),
  }
}

function paperTradeHistory(paper: PaperAccountState): PaperTradeHistoryEntry[] {
  return (paper.postMortems || [])
    .map(entry => {
      const parsed = parsePostMortemTradeFields(entry.markdown)
      const openedAt = entry.openedAt || parsed.openedAt
      const closedAt = entry.closedAt || parsed.closedAt || new Date().toISOString()
      const openedTime = openedAt ? Date.parse(openedAt) : Number.NaN
      const closedTime = Date.parse(closedAt)
      return {
        id: entry.id,
        ticker: entry.ticker,
        result: entry.result,
        openedAt: openedAt || null,
        closedAt,
        entryPrice: finiteMaybe(entry.entryPrice ?? parsed.entryPrice),
        exitPrice: finiteMaybe(entry.exitPrice ?? parsed.exitPrice),
        shares: finiteMaybe(entry.shares),
        pnl: Number(finiteOr(entry.pnl, 0).toFixed(2)),
        pnlPct: Number(finiteOr(entry.pnlPct, 0).toFixed(2)),
        holdingSeconds: Number.isFinite(openedTime) && Number.isFinite(closedTime)
          ? Math.max(0, Math.floor((closedTime - openedTime) / 1000))
          : null,
        note: parsed.insight || tradeResultNote(entry),
      }
    })
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
}

function buildPaperEquityCurve(paper: PaperAccountState, trades: PaperTradeHistoryEntry[]): PaperEquityCurvePoint[] {
  const orderedTrades = [...trades].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))
  const now = Math.floor(Date.now() / 1000)
  const initialCapital = finiteOr(paper.initialCapital, 1000)
  let runningEquity = initialCapital
  const points: PaperEquityCurvePoint[] = []
  const firstTradeTime = orderedTrades[0]?.openedAt || orderedTrades[0]?.closedAt
  const startTime = firstTradeTime
    ? Math.max(1, Math.floor(Date.parse(firstTradeTime) / 1000))
    : Math.max(1, now - 7 * 86_400)

  points.push({ time: startTime, value: round2(initialCapital) })
  for (const trade of orderedTrades) {
    const closeTime = Math.floor(Date.parse(trade.closedAt) / 1000)
    if (!Number.isFinite(closeTime) || closeTime <= 0) continue
    runningEquity += finiteOr(trade.pnl, 0)
    points.push({ time: closeTime, value: round2(runningEquity) })
  }

  const currentEquity = round2(paperEquity(paper))
  const lastPoint = points[points.length - 1]
  if (!lastPoint || now > lastPoint.time) {
    points.push({ time: now, value: currentEquity })
  } else if (lastPoint) {
    lastPoint.value = currentEquity
  }

  return mergeSameTimeEquityPoints(points)
}

function mergeSameTimeEquityPoints(points: PaperEquityCurvePoint[]): PaperEquityCurvePoint[] {
  const byTime = new Map<number, PaperEquityCurvePoint>()
  for (const point of points) {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) continue
    byTime.set(Math.floor(point.time), { time: Math.floor(point.time), value: round2(point.value) })
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time)
}

function parsePostMortemTradeFields(markdown: string): {
  openedAt?: string
  closedAt?: string
  entryPrice?: number
  exitPrice?: number
  insight?: string
} {
  const openedAt = markdown.match(/- \*\*Opened:\*\*\s*(.+)/)?.[1]?.trim()
  const closedAt = markdown.match(/- \*\*Closed:\*\*\s*(.+)/)?.[1]?.trim()
  const entryExit = markdown.match(/- \*\*Entry \/ Exit:\*\*\s*\$?([\d.]+|n\/a)\s*->\s*\$?([\d.]+|n\/a)/i)
  const insight = markdown.match(/- \*\*Actionable Insight:\*\*\s*(.+)/)?.[1]?.trim()
  return {
    openedAt: openedAt && openedAt !== 'n/a' ? openedAt : undefined,
    closedAt: closedAt && closedAt !== 'n/a' ? closedAt : undefined,
    entryPrice: parseMaybeNumber(entryExit?.[1]),
    exitPrice: parseMaybeNumber(entryExit?.[2]),
    insight,
  }
}

function parseMaybeNumber(value?: string): number | undefined {
  if (!value || value.toLowerCase() === 'n/a') return undefined
  const parsed = Number(value.replace(/[$,]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function finiteMaybe(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Number(Number(value).toFixed(4)) : null
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function round2(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0
}

function tradeResultNote(entry: PaperPostMortemEntry): string {
  return entry.result === 'Win'
    ? 'Paper trade closed profitably.'
    : entry.result === 'Loss'
      ? 'Paper trade closed at a loss; review risk notes.'
      : 'Paper trade closed flat.'
}

function formatTopList(snapshot: QuantLabSnapshot, count: number): string {
  return snapshot.topPicks
    .slice(0, count)
    .map((pick, index) => `${index + 1}. ${pick.ticker} ${pick.score} ${pick.action} ${pick.risk} ${pick.trend} - ${pick.reason}`)
    .join('\n')
}

function tableEscape(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ')
}

function decisionJournalRows(snapshot: QuantLabSnapshot): string {
  return snapshot.topPicks
    .slice(0, 6)
    .map(pick => {
      const score = (pick as typeof pick & {
        scoreBreakdown?: { confidence: string; notes: string[]; source: string }
      }).scoreBreakdown
      const why = `${pick.reason}; score ${pick.score}; trend ${pick.trend}; confidence ${score?.confidence || 'n/a'}`
      const validation = pick.action === 'BUY'
        ? 'Verify price holds above short-term support and macro risk does not worsen.'
        : pick.action === 'WATCH'
          ? 'Verify breakout, pullback support, or risk score improvement before adding.'
          : 'Verify thesis remains intact; no add unless score improves.'
      return `| ${pick.ticker} | ${pick.action} | ${tableEscape(why)} | ${pick.risk} / ${score?.source || 'n/a'} | ${validation} |`
    })
    .join('\n')
}

function tomorrowValidationRows(snapshot: QuantLabSnapshot, paper: PaperAccountState): string {
  const openTickers = paper.positions.map(position => position.ticker)
  const topTickers = snapshot.topPicks.slice(0, 4).map(pick => pick.ticker)
  const tickers = Array.from(new Set([...openTickers, ...topTickers])).slice(0, 8)
  if (!tickers.length) return '- No open positions; validate market regime, VIX, 10Y, and Top 10 ranking drift.'

  return tickers
    .map(ticker => {
      const pick = snapshot.topPicks.find(item => item.ticker === ticker)
      const position = paper.positions.find(item => item.ticker === ticker)
      const positionText = position ? `position ${formatMoney(positionValue(position))}, stop ${position.stop}` : 'watchlist only'
      return `- ${ticker}: ${positionText}; next validation ${pick?.action || 'WATCH'} score ${pick?.score ?? 'n/a'}, trend ${pick?.trend || 'n/a'}, thesis ${pick?.reason || 'n/a'}.`
    })
    .join('\n')
}

function universalTopicFromEvidence(evidence: MiroFishEvidenceItem[] = []): string {
  const topicEvidence = evidence.find(item => item.category === 'topic')
  const fromTitle = topicEvidence?.title?.replace(/^Universal topic:\s*/i, '').trim()
  return fromTitle || ''
}

function isUniversalMiroFishEvidence(evidence: MiroFishEvidenceItem[] = []): boolean {
  return isUniversalMiroFishTopic(universalTopicFromEvidence(evidence))
}

function buildMiroFishRequirement(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, topic = ''): string {
  const universalTopic = normalizeMiroFishTopic(topic)
  if (isUniversalMiroFishTopic(universalTopic)) {
    return `請以 Aurora OS Universal Brain 模式推演主題「${universalTopic}」。請建立至少三種情境：支持推進、先做小規模試點、暫緩或反對；比較機會、風險、治理、安全、成本、維護負擔與可逆性之間的因果鏈，輸出可驗證的下一步、失效條件與不確定性。這是唯讀認知沙盒，不可執行外部動作、不可寫入長期記憶以外的系統狀態。`
  }
  return `請根據 Hermes Quant Lab ${phaseLabel(phase)}資料，推演未來 1-5 個交易日美股科技/大型股情境。請建立至少三種情境：基本、風險升高、風險降低；比較 Top 10 候選、VIX、10Y、美股指數與資金流之間的因果鏈，輸出可驗證的明日觀察指標、失效條件與不確定性。這是 paper trading 研究，不可視為實盤交易指令。`
}

function mirofishSeedDir(): string {
  return resolve(resolveKnowledgeRoot(), 'raw', 'mirofish', 'seeds')
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function extractXmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? decodeXmlText(match[1]) : ''
}

function extractRssEvidence(xml: string, source: string, category: MiroFishEvidenceCategory, tickers: string[], limit: number): MiroFishEvidenceItem[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || []
  return items.slice(0, limit).map(item => ({
    category,
    source,
    title: extractXmlTag(item, 'title') || `${source} item`,
    summary: extractXmlTag(item, 'description') || 'RSS item fetched but description was empty.',
    url: extractXmlTag(item, 'link') || undefined,
    publishedAt: extractXmlTag(item, 'pubDate') || undefined,
    tickers,
    importance: 'medium',
  }))
}

async function fetchRssEvidence(url: string, source: string, category: MiroFishEvidenceCategory, tickers: string[], limit: number): Promise<MiroFishEvidenceItem[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Hermes Quant Lab Phase5/1.0',
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(4_500),
  })
  if (!response.ok) throw new Error(`${source} RSS HTTP ${response.status}`)
  return extractRssEvidence(await response.text(), source, category, tickers, limit)
}

async function buildMiroFishEvidencePack(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState): Promise<MiroFishEvidenceItem[]> {
  const guard = evaluateTradingRisk(paper, snapshot)
  const topTickers = snapshot.topPicks.slice(0, 10).map(pick => pick.ticker)
  const decisionWithVix = snapshot.decision as typeof snapshot.decision & { vix?: number }
  const currentVix = Number(decisionWithVix?.vix ?? Number.parseFloat(getPulseValue(snapshot, 'VIX')))
  const internalEvidence: MiroFishEvidenceItem[] = [
    ...snapshot.topPicks.slice(0, 10).map((pick): MiroFishEvidenceItem => {
      const score = (pick as typeof pick & { scoreBreakdown?: { confidence?: string } }).scoreBreakdown
      return {
        category: 'top10',
        source: `Hermes Quant Lab ${snapshot.source}`,
        title: `${pick.ticker} ${pick.action} score ${pick.score}`,
        summary: `${pick.reason}; trend ${pick.trend}; risk ${pick.risk}; price ${formatMoney(pick.price)}; confidence ${score?.confidence || 'n/a'}.`,
        tickers: [pick.ticker],
        importance: pick.score >= 88 ? 'high' : pick.score >= 82 ? 'medium' : 'low',
      }
    }),
    {
      category: 'vix',
      source: 'Hermes market pulse',
      title: `VIX state ${getPulseValue(snapshot, 'VIX')}`,
      summary: `VIX is used as the volatility stress switch. Guardrail status: ${guard.checks.find(check => check.key === 'vix-spike')?.status || 'n/a'} / ${guard.checks.find(check => check.key === 'vix-spike')?.reason || 'n/a'}.`,
      importance: guard.checks.find(check => check.key === 'vix-spike')?.status === 'BLOCK' ? 'high' : 'medium',
    },
    {
      category: 'bond',
      source: 'Hermes market pulse',
      title: `10Y state ${getPulseValue(snapshot, '10Y')}`,
      summary: `10Y yield pressure is used to cap multiple expansion and semis/mega-cap risk appetite. Guardrail: ${guard.checks.find(check => check.key === 'ten-year-rise')?.status || 'n/a'} / ${guard.checks.find(check => check.key === 'ten-year-rise')?.reason || 'n/a'}.`,
      importance: guard.checks.find(check => check.key === 'ten-year-rise')?.status === 'BLOCK' ? 'high' : 'medium',
    },
    {
      category: 'risk',
      source: 'Hermes Phase 4 guardrails',
      title: `Risk gate ${guard.status}`,
      summary: `${guard.reason}${guard.prohibited.length ? ` Prohibited: ${guard.prohibited.join('; ')}` : ''}`,
      importance: guard.status === 'BLOCKED' ? 'high' : 'medium',
    },
    {
      category: 'paper',
      source: 'Hermes paper account',
      title: `Paper account equity ${formatMoney(paperEquity(paper))}`,
      summary: `Cash ${formatMoney(paper.cash)}; positions ${paper.positions.map(position => `${position.ticker} ${formatMoney(positionValue(position))}`).join(', ') || 'none'}; daily P/L ${paperDailyReturnPct(paper).toFixed(2)}%; max DD ${paperDrawdownPct(paper).toFixed(2)}%.`,
      tickers: paper.positions.map(position => position.ticker),
      importance: 'medium',
    },
    {
      category: 'earnings',
      source: 'Hermes score notes',
      title: 'Earnings and quality proxies',
      summary: snapshot.topPicks
        .slice(0, 6)
        .map(pick => {
          const score = (pick as typeof pick & { scoreBreakdown?: { notes?: string[] } }).scoreBreakdown
          return `${pick.ticker}: ${score?.notes?.join('; ') || pick.reason}`
        })
        .join(' | '),
      tickers: topTickers.slice(0, 6),
      importance: 'medium',
    },
    {
      category: 'system',
      source: 'Hermes data health',
      title: `Data health ${snapshot.dataHealth.status || 'OK'} ${snapshot.dataHealth.quoteCoverage}`,
      summary: `Quote source ${snapshot.dataHealth.quoteSource}; provider ${snapshot.dataHealth.quoteProvider || 'n/a'}; backtest ${snapshot.dataHealth.backtestSource}; provider errors ${(snapshot.dataHealth.providerErrors || []).join(' | ') || 'none'}.`,
      importance: snapshot.dataHealth.status === 'OK' ? 'low' : 'high',
    },
  ]

  const memoryContext = await retrievePastLessonsForTickers(
    topTickers.slice(0, 6),
    currentVix,
    {
      knowledgeRoot: resolveKnowledgeRoot(),
      maxLessons: 3,
    }
  )
  if (memoryContext) {
    internalEvidence.push({
      category: 'memory',
      source: 'OpenClaw post-mortem RAG',
      title: 'OpenClaw historical lessons retrieved',
      summary: memoryContext,
      tickers: topTickers.slice(0, 6),
      importance: 'high',
    })
  }

  const tickerNewsTasks = topTickers.slice(0, 5).map(ticker =>
    fetchRssEvidence(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`,
      `Yahoo Finance RSS ${ticker}`,
      'ticker-news',
      [ticker],
      2
    )
  )
  const macroTasks = [
    fetchRssEvidence('https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC World RSS', 'world-news', [], 3),
    fetchRssEvidence('https://www.investing.com/rss/news.rss', 'Investing.com RSS', 'macro', [], 3),
  ]

  const externalSettled = await Promise.allSettled([...tickerNewsTasks, ...macroTasks])
  const externalEvidence = externalSettled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  const failedSources = externalSettled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => errorMessage(result.reason))

  if (failedSources.length) {
    internalEvidence.push({
      category: 'system',
      source: 'Hermes external evidence fetch',
      title: 'External news feed partially unavailable',
      summary: failedSources.slice(0, 4).join(' | '),
      importance: 'medium',
    })
  }

  return [...internalEvidence, ...externalEvidence].slice(0, 40)
}

function evidenceRows(evidence: MiroFishEvidenceItem[]): string {
  if (!evidence.length) return '| - | - | - | - | - | - |'
  return evidence
    .map(item => `| ${item.category} | ${tableEscape(item.source)} | ${tableEscape(item.title)} | ${tableEscape(item.tickers?.join(', ') || '-')} | ${item.importance} | ${tableEscape(item.summary)} |`)
    .join('\n')
}

function riskInferenceLines(risk: QuantRiskEvaluation, status: QuantRiskCheckStatus): string[] {
  return risk.checks
    .filter(check => check.status === status)
    .map(check => `${check.label}: ${check.value} / ${check.reason}`)
}

async function buildUniversalMiroFishEvidencePack(topic: string, phase: QuantLabBriefPhase): Promise<MiroFishEvidenceItem[]> {
  const now = new Date().toISOString()
  return [
    {
      category: 'topic',
      source: 'Aurora OmniBar',
      title: `Universal topic: ${topic}`,
      summary: `User requested a cross-domain MiroFish simulation for "${topic}" during ${phaseLabel(phase)}. The system should reason about benefits, risks, assumptions, and reversible next steps.`,
      publishedAt: now,
      importance: 'high',
    },
    {
      category: 'context',
      source: 'Aurora Universal Brain',
      title: 'Potential upside and learning value',
      summary: 'Evaluate strategic leverage, learning speed, user value, optionality, and whether a small pilot can validate the core thesis.',
      publishedAt: now,
      importance: 'high',
    },
    {
      category: 'risk',
      source: 'Aurora Universal Brain',
      title: 'Governance, maintenance, and reversibility risks',
      summary: 'Stress-test hidden maintenance cost, irreversible commitments, permission boundaries, safety governance, and unclear ownership.',
      publishedAt: now,
      importance: 'high',
    },
    {
      category: 'system',
      source: 'Aurora OS',
      title: 'Read-only cognitive sandbox',
      summary: 'This simulation is advisory only. It should produce a structured decision hypothesis, not perform external actions.',
      publishedAt: now,
      importance: 'medium',
    },
  ]
}

function buildMiroFishDebateEvidencePack(
  snapshot: QuantLabSnapshot,
  phase: QuantLabBriefPhase,
  paper: PaperAccountState,
  evidence: MiroFishEvidenceItem[],
  topic = '',
): MiroFishDebateEvidencePack {
  const universalTopic = isUniversalMiroFishTopic(topic)
  if (universalTopic) {
    const openClawMemoryContext = evidence.find(item => item.category === 'memory')?.summary || ''
    return {
      topic,
      domain: 'universal',
      agentLabels: {
        context: 'Contextual Analyst',
        proponent: 'Proponent Agent',
        risk: 'Risk Assessor Agent',
        judge: 'Hermes Synthesizer',
      },
      phase,
      generatedAt: snapshot.generatedAt,
      source: 'aurora-universal-brain',
      marketRegime: 'cognitive-sandbox',
      dataHealth: {
        status: 'OK',
        quoteSource: 'aurora-topic-context',
        quoteCoverage: 'topic-only',
        providerErrors: [],
      },
      riskGate: {
        status: 'OK',
        reason: 'Read-only cross-domain simulation.',
        prohibited: [],
      },
      topCandidates: [],
      evidence,
      openClawMemoryContext,
    }
  }

  const risk = evaluateTradingRisk(paper, snapshot)
  const openClawMemoryContext = evidence.find(item => item.category === 'memory' && item.source === 'OpenClaw post-mortem RAG')?.summary || ''
  return {
    phase,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    marketRegime: getPulseValue(snapshot, 'Regime'),
    macroData: {
      vix: firstNumberFromText(getPulseValue(snapshot, 'VIX')),
      tenYearYield: firstNumberFromText(getPulseValue(snapshot, '10Y')),
      cpi: firstNumberFromText(evidence.find(item => /cpi|inflation/i.test(`${item.title} ${item.summary}`))?.summary) ?? null,
    },
    dataHealth: {
      status: snapshot.dataHealth.status,
      quoteSource: snapshot.dataHealth.quoteSource,
      quoteCoverage: snapshot.dataHealth.quoteCoverage,
      providerErrors: snapshot.dataHealth.providerErrors,
    },
    riskGate: {
      status: risk.status,
      reason: risk.reason,
      prohibited: risk.prohibited,
    },
    paperAccount: {
      equity: Number(paperEquity(paper).toFixed(2)),
      cash: Number(paper.cash.toFixed(2)),
      positions: paper.positions.map(position => ({
        ticker: position.ticker,
        value: Number(positionValue(position).toFixed(2)),
        pnlPct: Number(positionPnlPct(position).toFixed(2)),
        risk: position.stop,
      })),
    },
    topCandidates: snapshot.topPicks.slice(0, 10).map(pick => ({
      ticker: pick.ticker,
      score: pick.score,
      action: pick.action,
      risk: pick.risk,
      trend: pick.trend,
      price: pick.price,
      reason: pick.reason,
    })),
    evidence,
    openClawMemoryContext,
  }
}

function applyMiroFishDebateToInference(inference: MiroFishInference, debate: MiroFishDebateResult): MiroFishInference {
  const bullishPct = Math.round(debate.scenarios.bullish.probability * 100)
  const neutralPct = Math.round(debate.scenarios.neutral.probability * 100)
  const bearishPct = Math.round(debate.scenarios.bearish.probability * 100)
  const macroLine = `Macro Agent：${debate.macro.Regime} / RiskMultiplier ${debate.macro.RiskMultiplier.toFixed(2)}；${debate.macro.MacroInsight}`
  const debateLine = `Bull/Bear/Judge 情境：Bullish ${bullishPct}% / Neutral ${neutralPct}% / Bearish ${bearishPct}%（${debate.mode}${debate.ok ? '' : ' fallback'}）。`
  const judgeReason = `Judge reasoning：${debate.scenarios.neutral.reasoning}`
  const support = [
    ...inference.support,
    `Bull Agent：${debate.scenarios.bullish.reasoning}`,
  ]
  const oppose = [
    ...inference.oppose,
    ...(debate.macro.RiskMultiplier < 0.5 ? [macroLine] : []),
    ...debate.key_risks.slice(0, 4).map(risk => `Debate key risk：${risk}`),
  ]
  const neutral = [
    ...inference.neutral,
    macroLine,
    debateLine,
    judgeReason,
    '多智能體推演僅能支持或反對 paper thesis，不可取代 Phase 4 風控與人工確認。',
  ]
  return {
    ...inference,
    support,
    oppose,
    neutral,
    debate,
  }
}

function buildLocalMiroFishInference(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState, evidence: MiroFishEvidenceItem[]): MiroFishInference {
  const risk = evaluateTradingRisk(paper, snapshot)
  const highScoreBuys = snapshot.topPicks.filter(pick => pick.action === 'BUY' && pick.score >= 85)
  const watchNames = snapshot.topPicks.filter(pick => pick.action === 'WATCH').slice(0, 4)
  const riskOn = getPulseValue(snapshot, 'Regime').toLowerCase().includes('risk-on')
  const externalNewsCount = evidence.filter(item => item.category === 'ticker-news' || item.category === 'world-news' || item.category === 'macro').length

  const support = [
    riskOn ? `市場 regime 偏 Risk-on，支持以高分大型股作為 paper watchlist 主軸。` : '',
    highScoreBuys.length ? `${highScoreBuys.map(pick => `${pick.ticker} ${pick.score}`).join(' / ')} 為高分 BUY 候選，基本情境支持續留觀察。` : '',
    risk.checks.some(check => check.key === 'vix-spike' && check.status === 'PASS') ? `VIX guard 未觸發封鎖，波動條件暫可接受。` : '',
    paper.positions.length ? `現有 paper position 可作為情境驗證樣本：${paper.positions.map(position => position.ticker).join(', ')}。` : '',
  ].filter(Boolean)

  const oppose = [
    ...riskInferenceLines(risk, 'BLOCK'),
    ...riskInferenceLines(risk, 'WARN').slice(0, 4),
    snapshot.dataHealth.status && snapshot.dataHealth.status !== 'OK'
      ? `資料健康度不是 OK：${snapshot.dataHealth.status} ${snapshot.dataHealth.quoteCoverage}，推演信心需下修。`
      : '',
  ].filter(Boolean)

  const neutral = [
    watchNames.length ? `觀察名單 ${watchNames.map(pick => pick.ticker).join(' / ')} 需要突破、回測或風險改善後才提高權重。` : '',
    externalNewsCount ? `已納入 ${externalNewsCount} 則外部 RSS 新聞/宏觀證據。` : `外部新聞/財報 feed 目前不足，先以 Hermes Top 10、VIX、10Y、風控與 paper account 推演。`,
    `Phase ${phase} seed 已可交給 MiroFish backend 建圖；AI 只能提出建議，不能繞過風控。`,
  ].filter(Boolean)

  const confidence: MiroFishConfidence =
    risk.status === 'BLOCKED' || snapshot.dataHealth.status === 'FALLBACK' || snapshot.dataHealth.status === 'ERROR'
      ? 'low'
      : externalNewsCount >= 5 && snapshot.dataHealth.status === 'OK'
        ? 'high'
        : 'medium'

  return {
    status: 'seed_saved',
    confidence,
    support: support.length ? support : ['目前沒有足夠的正向推演證據，維持觀察。'],
    oppose: oppose.length ? oppose : ['目前沒有重大反向封鎖訊號，但仍需遵守 paper guardrails。'],
    neutral,
    evidenceCount: evidence.length,
    updatedAt: new Date().toISOString(),
  }
}

function buildUniversalMiroFishInference(topic: string, phase: QuantLabBriefPhase, evidence: MiroFishEvidenceItem[], debate: MiroFishDebateResult): MiroFishInference {
  const bullishPct = Math.round(debate.scenarios.bullish.probability * 100)
  const neutralPct = Math.round(debate.scenarios.neutral.probability * 100)
  const bearishPct = Math.round(debate.scenarios.bearish.probability * 100)
  const confidence: MiroFishConfidence = debate.macro.RiskMultiplier >= 0.7 ? 'high' : debate.macro.RiskMultiplier >= 0.5 ? 'medium' : 'low'

  return {
    status: 'seed_saved',
    confidence,
    support: [
      `Proponent Agent：${debate.scenarios.bullish.reasoning}`,
      `主題「${topic}」可先以小規模試點收集真實訊號。`,
    ],
    oppose: [
      ...debate.key_risks.slice(0, 5).map(risk => `Debate key risk：${risk}`),
    ],
    neutral: [
      `Contextual Analyst：${debate.macro.Regime} / RiskMultiplier ${debate.macro.RiskMultiplier.toFixed(2)}；${debate.macro.MacroInsight}`,
      `Hermes Synthesizer 情境：Favorable ${bullishPct}% / Pilot ${neutralPct}% / Pause ${bearishPct}%（${debate.mode}${debate.ok ? '' : ' fallback'}）。`,
      `Phase ${phase} universal seed 已建立；AI 只提供決策推演，不執行外部動作。`,
    ],
    evidenceCount: evidence.length,
    debate,
    updatedAt: new Date().toISOString(),
  }
}

function buildMiroFishSeedMarkdown(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState, evidence: MiroFishEvidenceItem[]): string {
  const universalTopic = universalTopicFromEvidence(evidence)
  const requirement = buildMiroFishRequirement(snapshot, phase, universalTopic)
  if (isUniversalMiroFishTopic(universalTopic)) {
    return `---
title: Aurora Universal Brain Seed ${phaseLabel(phase)} ${todayKey()}
created: ${new Date().toISOString()}
type: mirofish-universal-seed
status: active
phase: ${phase}
topic: ${yamlString(universalTopic)}
tags:
  - aurora
  - universal-brain
  - mirofish
  - cognitive-sandbox
confidence: medium
owner: hermes
source: aurora-universal-brain
---

# Aurora Universal Brain Seed ${phaseLabel(phase)} ${todayKey()}

simulation_requirement: |
  ${requirement}

## Topic

- Question: ${universalTopic}
- Mode: read-only cognitive sandbox
- Boundary: advisory reasoning only; no external action execution.

## Evidence Pack

| Category | Source | Title | Tickers | Importance | Summary |
|---|---|---|---|---|---|
${evidenceRows(evidence)}

## Scenario Questions

1. 支持推進此主題的最強因果鏈是什麼？
2. 反對或暫緩的最大風險、成本、治理與安全因素是什麼？
3. 若採取小規模試點，最小可驗證行動與成功/失敗指標是什麼？
4. 哪些假設若被推翻，應立即改變決策？

## Expected MiroFish Output Contract

- support: 支持目前主題推進的因果鏈。
- oppose: 反對、暫緩或削弱目前主題的風險鏈。
- neutral: 資料不足、需等待確認、或只適合小規模試點的條件。
- confidence: low / medium / high，必須受證據品質與可逆性限制。
- action_boundary: 僅可產生認知沙盒推演，不可執行外部動作。
`
  }

  const pulseRows = snapshot.marketPulse.map(item => `| ${item.label} | ${tableEscape(item.value)} | ${item.tone} |`).join('\n')
  const topRows = snapshot.topPicks
    .map(pick => `| ${pick.ticker} | ${pick.score} | ${pick.action} | ${pick.risk} | ${pick.trend} | ${pick.price} | ${tableEscape(pick.reason)} |`)
    .join('\n')
  const positionRows = paper.positions.length
    ? paper.positions.map(position => `| ${position.ticker} | ${formatMoney(positionValue(position))} | ${formatMoney(position.avgCost)} | ${formatMoney(position.lastPrice)} | ${tableEscape(position.stop)} |`).join('\n')
    : '| - | - | - | - | - |'
  const guard = evaluateTradingRisk(paper, snapshot)

  return `---
title: MiroFish Quant Lab Seed ${phaseLabel(phase)} ${todayKey()}
created: ${new Date().toISOString()}
type: mirofish-seed
status: active
phase: ${phase}
tags:
  - hermes
  - quant-lab
  - mirofish
  - simulation-seed
confidence: medium
owner: hermes
source: ${snapshot.source}
---

# MiroFish Quant Lab Seed ${phaseLabel(phase)} ${todayKey()}

simulation_requirement: |
  ${requirement}

## Market State

| Indicator | Value | Tone |
|---|---:|---|
${pulseRows}

## Hermes Decision

- Conclusion: ${snapshot.decision.conclusion}
- Action: ${snapshot.decision.action}
- Invalidation: ${snapshot.decision.invalidation}
- Data health: ${snapshot.dataHealth.quoteCoverage}, quote source ${snapshot.dataHealth.quoteSource}, backtest ${snapshot.dataHealth.backtestSource}

## Top 10 Candidates

| Ticker | Score | Action | Risk | Trend | Price | Thesis |
|---|---:|---|---|---:|---:|---|
${topRows}

## Phase 5 Evidence Pack

| Category | Source | Title | Tickers | Importance | Summary |
|---|---|---|---|---|---|
${evidenceRows(evidence)}

## Paper Account And Guardrails

- Equity: ${formatMoney(paperEquity(paper))}
- Cash: ${formatMoney(paper.cash)}
- Daily P/L: ${paperDailyReturnPct(paper).toFixed(2)}%
- Drawdown: ${paperDrawdownPct(paper).toFixed(2)}%
- Guard: ${guard.status} / ${guard.reason}
- Consecutive realized losses: ${ensurePaperRiskState(paper).consecutiveLosses}

| Ticker | Value | Avg Cost | Last Price | Stop |
|---|---:|---:|---:|---|
${positionRows}

## Scenario Questions

1. 哪些 Top 10 候選在 VIX 上升或 10Y 上升時最容易失效？
2. 如果 QQQ 轉弱，哪些持倉應降低曝險，哪些只需觀察？
3. 若市場維持 Risk-on，哪兩檔最適合作為下一次 paper buy 觀察？
4. 明天最應驗證的三個市場指標是什麼？

## Expected MiroFish Output Contract

- support: 支持目前 Top 10 / paper stance 的因果鏈。
- oppose: 反對或削弱目前 stance 的風險鏈。
- neutral: 資料不足、需等待確認、或只能維持觀察的條件。
- confidence: low / medium / high，必須受資料健康度與風控狀態限制。
- action_boundary: 僅可產生 paper trading research，不可產生真實交易指令。
`
}

async function saveMiroFishSeed(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState, evidence?: MiroFishEvidenceItem[]) {
  const root = resolveKnowledgeRoot()
  const seedDir = mirofishSeedDir()
  const seedEvidence = evidence || await buildMiroFishEvidencePack(snapshot, phase, paper)
  const universalTopic = universalTopicFromEvidence(seedEvidence)
  const baseName = isUniversalMiroFishTopic(universalTopic)
    ? `${todayKey()}-aurora-universal-brain-${phase}-${safeMemorySlug(universalTopic)}-mirofish-seed`
    : `${todayKey()}-quant-lab-${phase}-mirofish-seed`
  const targetPath = resolve(seedDir, `${baseName}.md`)

  if (!targetPath.startsWith(seedDir)) {
    const err = new Error('Invalid MiroFish seed path') as Error & { code?: string }
    err.code = 'invalid_path'
    throw err
  }

  await mkdir(seedDir, { recursive: true })
  await writeFile(targetPath, buildMiroFishSeedMarkdown(snapshot, phase, paper, seedEvidence), 'utf-8')

  return {
    status: 'seed_saved',
    requirement: buildMiroFishRequirement(snapshot, phase, universalTopic),
    path: targetPath,
    relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
    evidence: seedEvidence,
  }
}

function resolveMiroFishBackendUrl(): string {
  return (getProfileEnvValue('MIROFISH_BACKEND_URL') || 'http://localhost:5001').replace(/\/+$/, '')
}

async function probeMiroFishBackend(): Promise<{ ok: boolean; url: string; status: string; error?: string }> {
  const url = resolveMiroFishBackendUrl()
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_500) })
    const body = await response.json().catch(() => ({}))
    return {
      ok: response.ok && body?.status === 'ok',
      url,
      status: response.ok ? String(body?.service || body?.status || 'ok') : `HTTP ${response.status}`,
    }
  } catch (err) {
    return {
      ok: false,
      url,
      status: 'unavailable',
      error: miroFishSafeErrorMessage(err, 'MiroFish backend did not pass health check.'),
    }
  }
}

function textQueryValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text || undefined
}

async function fetchMiroFishBackendJson(url: string): Promise<{ ok: boolean; body: any; error?: string; status?: number }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6_000) })
    const text = await response.text().catch(() => '')
    const parsed = parseMiroFishBackendJsonText(text)
    const body = parsed.body
    const backendError = sanitizeMiroFishGatewayText(body?.error || body?.detail || body?.message)
    return {
      ok: response.ok && body?.success !== false && !parsed.error,
      body,
      status: response.status,
      error: parsed.error || backendError || (response.ok ? undefined : `HTTP ${response.status}`),
    }
  } catch (err) {
    return { ok: false, body: {}, error: miroFishSafeErrorMessage(err, 'MiroFish graph backend unavailable.') }
  }
}

function normalizeMiroFishTask(data: any): MiroFishGraphTaskStatus['task'] | undefined {
  if (!data || typeof data !== 'object') return undefined
  const result = data.result && typeof data.result === 'object' ? data.result as Record<string, unknown> : undefined
  return {
    taskId: data.task_id ? String(data.task_id) : data.id ? String(data.id) : undefined,
    taskType: data.task_type ? String(data.task_type) : undefined,
    status: data.status ? String(data.status) : undefined,
    progress: isNumber(data.progress) ? data.progress : undefined,
    message: data.message ? String(data.message) : undefined,
    error: data.error ? String(data.error) : null,
    result,
    updatedAt: data.updated_at ? String(data.updated_at) : data.updatedAt ? String(data.updatedAt) : undefined,
    createdAt: data.created_at ? String(data.created_at) : data.createdAt ? String(data.createdAt) : undefined,
  }
}

function normalizeMiroFishProject(data: any): MiroFishGraphTaskStatus['project'] | undefined {
  if (!data || typeof data !== 'object') return undefined
  return {
    projectId: data.project_id ? String(data.project_id) : data.id ? String(data.id) : undefined,
    status: data.status ? String(data.status) : undefined,
    graphId: data.graph_id ? String(data.graph_id) : undefined,
    graphBuildTaskId: data.graph_build_task_id ? String(data.graph_build_task_id) : undefined,
    name: data.name ? String(data.name) : data.project_name ? String(data.project_name) : undefined,
    updatedAt: data.updated_at ? String(data.updated_at) : data.updatedAt ? String(data.updatedAt) : undefined,
    error: data.error ? String(data.error) : null,
  }
}

function resolveMiroFishSourceRoot(): string {
  return getProfileEnvValue('MIROFISH_SOURCE_DIR') || '/Users/kk/Documents/Codex/Hermes-Quant-Workspace/mirofish'
}

function resolveMiroFishSourceRootCandidates(): string[] {
  return Array.from(new Set([
    getProfileEnvValue('MIROFISH_SOURCE_DIR'),
    '/Users/kk/Documents/Codex/Hermes-Quant-Workspace/mirofish',
  ].filter((value): value is string => Boolean(value))))
}

async function readLocalMiroFishGraphData(graphId: string): Promise<any | null> {
  const safeGraphId = graphId.replace(/[^A-Za-z0-9_.-]/g, '_')
  for (const sourceRoot of resolveMiroFishSourceRootCandidates()) {
    const graphDir = resolve(sourceRoot, 'backend', 'uploads', 'local_graphs')
    const targetPath = resolve(graphDir, `${safeGraphId}.json`)
    if (!targetPath.startsWith(graphDir) || !existsSync(targetPath)) continue
    return JSON.parse(await readFile(targetPath, 'utf-8'))
  }
  return null
}

async function latestLocalMiroFishGraphId(): Promise<string | undefined> {
  const entries = (await Promise.all(resolveMiroFishSourceRootCandidates().map(async (sourceRoot) => {
    const graphDir = resolve(sourceRoot, 'backend', 'uploads', 'local_graphs')
    if (!existsSync(graphDir)) return []
    const files = await readdir(graphDir).catch(() => [])
    return Promise.all(files
      .filter(file => file.endsWith('.json'))
      .map(async (file) => {
        const targetPath = resolve(graphDir, file)
        if (!targetPath.startsWith(graphDir)) return null
        const info = await stat(targetPath).catch(() => null)
        return info ? { graphId: file.replace(/\.json$/, ''), mtimeMs: info.mtimeMs } : null
      }))
  }))).flat()
  return entries
    .filter((entry): entry is { graphId: string; mtimeMs: number } => Boolean(entry))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.graphId
}

function normalizeGraphText(value: unknown): string {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function incrementCount(map: Map<string, number>, key: string): void {
  if (!key) return
  map.set(key, (map.get(key) || 0) + 1)
}

function topCountRows(map: Map<string, number>, limit = 8): Array<{ label: string; count: number }> {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit)
}

function trackedGraphAliases(): Array<{ symbol: string; aliases: string[] }> {
  return [
    ...getCandidateUniverse().slice(0, 30).map(item => ({ symbol: item.ticker, aliases: [item.ticker] })),
    { symbol: 'SPY', aliases: ['SPY'] },
    { symbol: 'QQQ', aliases: ['QQQ'] },
    { symbol: '^VIX', aliases: ['VIX', '^VIX'] },
    { symbol: '^TNX', aliases: ['10Y', 'TNX', '^TNX'] },
    { symbol: 'DX-Y.NYB', aliases: ['DXY', 'DX-Y.NYB'] },
    { symbol: 'CL=F', aliases: ['OIL', 'CL=F', 'CRUDE'] },
  ]
}

function summarizeMiroFishGraphData(input: { graphId: string; backendUrl: string; source: MiroFishGraphSummary['source']; graphData: any }): MiroFishGraphSummary {
  const nodes: any[] = Array.isArray(input.graphData?.nodes) ? input.graphData.nodes : []
  const edges: any[] = Array.isArray(input.graphData?.edges) ? input.graphData.edges : []
  const nodeMap = new Map<string, any>()
  const degree = new Map<string, number>()
  const nodeTypes = new Map<string, number>()
  const edgeTypes = new Map<string, number>()

  nodes.forEach((node) => {
    const uuid = String(node?.uuid || '')
    if (uuid) nodeMap.set(uuid, node)
    const labels = Array.isArray(node?.labels) ? node.labels : []
    if (!labels.length) incrementCount(nodeTypes, 'Unknown')
    labels.forEach((label: unknown) => incrementCount(nodeTypes, String(label || 'Unknown')))
  })

  edges.forEach((edge) => {
    const source = String(edge?.source_node_uuid || '')
    const target = String(edge?.target_node_uuid || '')
    if (source) degree.set(source, (degree.get(source) || 0) + 1)
    if (target) degree.set(target, (degree.get(target) || 0) + 1)
    incrementCount(edgeTypes, String(edge?.fact_type || edge?.name || 'RELATED_TO'))
  })

  const edgeSummary = (edge: any): MiroFishGraphEdgeSummary => ({
    source: String(edge?.source_node_name || nodeMap.get(String(edge?.source_node_uuid || ''))?.name || 'source'),
    target: String(edge?.target_node_name || nodeMap.get(String(edge?.target_node_uuid || ''))?.name || 'target'),
    type: String(edge?.fact_type || edge?.name || 'RELATED_TO'),
    fact: edge?.fact ? String(edge.fact).slice(0, 180) : undefined,
  })

  const trackedNodeMatches = trackedGraphAliases().map(({ symbol, aliases }) => {
    const normalizedAliases = aliases.map(normalizeGraphText)
    const match = nodes.find((node) => {
      const nodeName = normalizeGraphText(node?.name)
      return normalizedAliases.some(alias => nodeName === alias || (alias.length >= 3 && nodeName.includes(alias)))
    })
    const uuid = String(match?.uuid || '')
    return {
      uuid,
      symbol,
      present: Boolean(match),
      degree: uuid ? degree.get(uuid) || 0 : 0,
      name: match?.name ? String(match.name) : undefined,
      labels: Array.isArray(match?.labels) ? match.labels.map(String).slice(0, 4) : undefined,
      summary: match?.summary ? String(match.summary).slice(0, 160) : undefined,
      relatedEdges: uuid
        ? edges
          .filter(edge => String(edge?.source_node_uuid || '') === uuid || String(edge?.target_node_uuid || '') === uuid)
          .slice(0, 6)
          .map(edgeSummary)
        : [],
    }
  })
  const trackedNodes = trackedNodeMatches.map(({ uuid: _uuid, ...node }) => node)

  const topNodes = nodes
    .map((node) => ({
      node,
      degree: degree.get(String(node?.uuid || '')) || 0,
    }))
    .filter(item => item.degree > 0 && String(item.node?.name || '').trim())
    .sort((a, b) => b.degree - a.degree || String(a.node?.name || '').localeCompare(String(b.node?.name || '')))
    .slice(0, 10)
    .map(item => ({
      name: String(item.node.name),
      degree: item.degree,
      labels: Array.isArray(item.node.labels) ? item.node.labels.map(String).slice(0, 4) : [],
      summary: item.node.summary ? String(item.node.summary).slice(0, 160) : undefined,
    }))

  const trackedNames = new Set(trackedNodeMatches.filter(node => node.present).map(node => node.name))
  const trackedUuids = new Set(trackedNodeMatches.filter(node => node.present && node.uuid).map(node => node.uuid))
  const sampleEdges = edges
    .filter((edge) => {
      if (trackedNames.size === 0 && trackedUuids.size === 0) return true
      return trackedNames.has(String(edge?.source_node_name || '')) ||
        trackedNames.has(String(edge?.target_node_name || '')) ||
        trackedUuids.has(String(edge?.source_node_uuid || '')) ||
        trackedUuids.has(String(edge?.target_node_uuid || ''))
    })
    .slice(0, 8)
    .map(edgeSummary)

  return {
    ok: true,
    backendUrl: input.backendUrl,
    checkedAt: new Date().toISOString(),
    graphId: input.graphId,
    source: input.source,
    nodeCount: Number(input.graphData?.node_count || nodes.length || 0),
    edgeCount: Number(input.graphData?.edge_count || edges.length || 0),
    nodeTypes: topCountRows(nodeTypes),
    edgeTypes: topCountRows(edgeTypes),
    trackedNodes,
    topNodes,
    sampleEdges,
  }
}

async function getMiroFishGraphSummary(graphIdInput?: string): Promise<MiroFishGraphSummary> {
  const backendUrl = resolveMiroFishBackendUrl()
  const status = graphIdInput ? null : await getMiroFishGraphTaskStatus()
  const graphId =
    graphIdInput ||
    status?.graphId ||
    await latestLocalMiroFishGraphId()

  if (!graphId) {
    return {
      ok: false,
      backendUrl,
      checkedAt: new Date().toISOString(),
      source: 'none',
      nodeCount: 0,
      edgeCount: 0,
      nodeTypes: [],
      edgeTypes: [],
      trackedNodes: [],
      topNodes: [],
      sampleEdges: [],
      error: 'No MiroFish graph id available.',
    }
  }

  const backendResult = await fetchMiroFishBackendJson(`${backendUrl}/api/graph/data/${encodeURIComponent(graphId)}`)
  const backendGraphData = backendResult.ok ? backendResult.body?.data || backendResult.body : null
  if (backendGraphData?.nodes || backendGraphData?.edges) {
    return summarizeMiroFishGraphData({ graphId, backendUrl, source: 'backend', graphData: backendGraphData })
  }

  const localGraphData = await readLocalMiroFishGraphData(graphId)
  if (localGraphData?.nodes || localGraphData?.edges) {
    return summarizeMiroFishGraphData({ graphId, backendUrl, source: 'local-file', graphData: localGraphData })
  }

  return {
    ok: false,
    backendUrl,
    checkedAt: new Date().toISOString(),
    graphId,
    source: 'none',
    nodeCount: 0,
    edgeCount: 0,
    nodeTypes: [],
    edgeTypes: [],
    trackedNodes: [],
    topNodes: [],
    sampleEdges: [],
    error: backendResult.error || sanitizeMiroFishGatewayText(backendResult.body?.error) || 'MiroFish graph data unavailable.',
  }
}

async function getMiroFishGraphTaskStatus(taskIdInput?: string, projectIdInput?: string): Promise<MiroFishGraphTaskStatus> {
  const latestInference = !taskIdInput && !projectIdInput ? await getLatestMiroFishInference() : null
  const backendUrl = resolveMiroFishBackendUrl()
  const graphTaskId = taskIdInput || latestInference?.graphTaskId
  const projectId = projectIdInput || latestInference?.projectId
  const checkedAt = new Date().toISOString()

  if (!graphTaskId && !projectId) {
    return {
      ok: false,
      backendUrl,
      checkedAt,
      error: 'No MiroFish graph task id available.',
    }
  }

  const [taskResult, projectResult] = await Promise.all([
    graphTaskId
      ? fetchMiroFishBackendJson(`${backendUrl}/api/graph/task/${encodeURIComponent(graphTaskId)}`)
      : Promise.resolve({ ok: false, body: {}, error: undefined as string | undefined, status: undefined as number | undefined }),
    projectId
      ? fetchMiroFishBackendJson(`${backendUrl}/api/graph/project/${encodeURIComponent(projectId)}`)
      : Promise.resolve({ ok: false, body: {}, error: undefined as string | undefined, status: undefined as number | undefined }),
  ])
  const taskData = taskResult.body?.data || taskResult.body
  const projectData = projectResult.body?.data || projectResult.body
  const task = normalizeMiroFishTask(taskData)
  const project = normalizeMiroFishProject(projectData)
  const graphId =
    (task?.result?.graph_id ? String(task.result.graph_id) : undefined) ||
    project?.graphId

  return {
    ok: Boolean(taskResult.ok || projectResult.ok),
    backendUrl,
    checkedAt,
    projectId: project?.projectId || projectId,
    graphTaskId: task?.taskId || graphTaskId || project?.graphBuildTaskId,
    graphId,
    task,
    project,
    error: taskResult.error || projectResult.error || sanitizeMiroFishGatewayText(taskResult.body?.error) || sanitizeMiroFishGatewayText(projectResult.body?.error),
  }
}

async function submitMiroFishSeedToBackend(seed: Awaited<ReturnType<typeof saveMiroFishSeed>>, phase: QuantLabBriefPhase): Promise<Partial<MiroFishInference>> {
  const probe = await probeMiroFishBackend()
  if (!probe.ok) {
    return {
      status: 'backend_unavailable',
      backendUrl: probe.url,
      backendStatus: probe.status,
      error: probe.error || 'MiroFish backend did not pass health check.',
    }
  }

  try {
    const seedContent = await readFile(seed.path, 'utf-8')
    const form = new FormData()
    form.append('simulation_requirement', seed.requirement)
    form.append('project_name', `Hermes Quant Lab ${todayKey()} ${phase}`)
    form.append('additional_context', 'Hermes Phase 5 handoff. Paper trading research only; do not generate real brokerage actions.')
    form.append('files', new Blob([seedContent], { type: 'text/markdown' }), basename(seed.path))

    const ontologyResponse = await fetch(`${probe.url}/api/graph/ontology/generate`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(45_000),
    })
    const ontologyText = await ontologyResponse.text().catch(() => '')
    const ontologyParsed = parseMiroFishBackendJsonText(ontologyText)
    const ontologyJson = ontologyParsed.body
    if (!ontologyResponse.ok || ontologyJson?.success === false || ontologyParsed.error) {
      return {
        status: 'error',
        backendUrl: probe.url,
        backendStatus: probe.status,
        error: ontologyParsed.error || sanitizeMiroFishGatewayText(ontologyJson?.error) || `MiroFish ontology handoff failed: HTTP ${ontologyResponse.status}`,
      }
    }

    const projectId = ontologyJson?.data?.project_id ? String(ontologyJson.data.project_id) : undefined
    let graphTaskId: string | undefined
    if (projectId) {
      const buildResponse = await fetch(`${probe.url}/api/graph/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          graph_name: `Hermes Quant Lab ${todayKey()} ${phase}`,
          chunk_size: 700,
          chunk_overlap: 80,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const buildText = await buildResponse.text().catch(() => '')
      const buildParsed = parseMiroFishBackendJsonText(buildText)
      const buildJson = buildParsed.body
      if (buildResponse.ok && buildJson?.success !== false && !buildParsed.error) {
        graphTaskId = buildJson?.data?.task_id ? String(buildJson.data.task_id) : undefined
      }
    }

    return {
      status: 'submitted',
      backendUrl: probe.url,
      backendStatus: probe.status,
      projectId,
      graphTaskId,
    }
  } catch (err) {
    return {
      status: 'error',
      backendUrl: probe.url,
      backendStatus: probe.status,
      error: miroFishSafeErrorMessage(err),
    }
  }
}

function buildMiroFishInferenceMarkdown(input: {
  snapshot: QuantLabSnapshot
  phase: QuantLabBriefPhase
  paper: PaperAccountState
  seed: Awaited<ReturnType<typeof saveMiroFishSeed>>
  inference: MiroFishInference
  evidence: MiroFishEvidenceItem[]
}): string {
  const { snapshot, phase, paper, seed, inference, evidence } = input
  const supportRows = inference.support.map(item => `- ${item}`).join('\n')
  const opposeRows = inference.oppose.map(item => `- ${item}`).join('\n')
  const neutralRows = inference.neutral.map(item => `- ${item}`).join('\n')
  const debateRows = inference.debate
    ? [
        `- Mode: ${inference.debate.mode}${inference.debate.ok ? '' : ` / ${inference.debate.error || 'fallback'}`}`,
        `- Bullish: ${(inference.debate.scenarios.bullish.probability * 100).toFixed(0)}% / confidence ${(inference.debate.scenarios.bullish.confidence * 100).toFixed(0)}% / ${inference.debate.scenarios.bullish.reasoning}`,
        `- Neutral: ${(inference.debate.scenarios.neutral.probability * 100).toFixed(0)}% / confidence ${(inference.debate.scenarios.neutral.confidence * 100).toFixed(0)}% / ${inference.debate.scenarios.neutral.reasoning}`,
        `- Bearish: ${(inference.debate.scenarios.bearish.probability * 100).toFixed(0)}% / confidence ${(inference.debate.scenarios.bearish.confidence * 100).toFixed(0)}% / ${inference.debate.scenarios.bearish.reasoning}`,
        `- Key risks: ${inference.debate.key_risks.join(' | ') || 'none'}`,
      ].join('\n')
    : '- not generated'
  const universalTopic = universalTopicFromEvidence(evidence)

  if (isUniversalMiroFishTopic(universalTopic)) {
    return `---
title: Aurora Universal Brain Inference ${phaseLabel(phase)} ${todayKey()}
created: ${new Date().toISOString()}
type: universal-simulation-report
status: active
phase: ${phase}
topic: ${yamlString(universalTopic)}
tags:
  - aurora
  - universal-brain
  - mirofish
  - cognitive-os
confidence: ${inference.confidence}
owner: hermes
source: aurora-universal-brain
---

# Aurora Universal Brain Inference ${phaseLabel(phase)} ${todayKey()}

> Read-only cognitive sandbox. This report is not an external action instruction.
> MiroFish backend: ${inference.backendStatus || inference.status}${inference.backendUrl ? ` / ${inference.backendUrl}` : ''}

## Status

- Topic: ${universalTopic}
- Status: ${inference.status}
- Confidence: ${inference.confidence}
- Evidence count: ${inference.evidenceCount}
- Seed: ${seed.relativePath}
- Backend project: ${inference.projectId || 'none'}
- Graph task: ${inference.graphTaskId || 'none'}
- Error: ${inference.error || 'none'}

## Supports Current Stance

${supportRows}

## Opposes / Weakens Current Stance

${opposeRows}

## Neutral / Needs Confirmation

${neutralRows}

## Proponent / Risk / Synthesizer Debate

${debateRows}

## Evidence Pack

| Category | Source | Title | Tickers | Importance | Summary |
|---|---|---|---|---|---|
${evidenceRows(evidence)}

## Aurora Boundary

- AI may summarize, compare, and propose reversible next steps.
- AI cannot perform external actions or bypass Approval Gateway.
- Long-term memory writes are recorded as auditable Markdown artifacts.
`
  }

  return `---
title: MiroFish Quant Lab Inference ${phaseLabel(phase)} ${todayKey()}
created: ${new Date().toISOString()}
type: simulation-report
status: active
phase: ${phase}
tags:
  - hermes
  - quant-lab
  - mirofish
  - scenario-inference
confidence: ${inference.confidence}
owner: hermes
source: ${snapshot.source}
---

# MiroFish Quant Lab Inference ${phaseLabel(phase)} ${todayKey()}

> Paper trading research only. This report is not a real trade instruction.
> MiroFish backend: ${inference.backendStatus || inference.status}${inference.backendUrl ? ` / ${inference.backendUrl}` : ''}

## Status

- Status: ${inference.status}
- Confidence: ${inference.confidence}
- Evidence count: ${inference.evidenceCount}
- Seed: ${seed.relativePath}
- Backend project: ${inference.projectId || 'none'}
- Graph task: ${inference.graphTaskId || 'none'}
- Error: ${inference.error || 'none'}

## Supports Current Stance

${supportRows}

## Opposes / Weakens Current Stance

${opposeRows}

## Neutral / Needs Confirmation

${neutralRows}

## Bull / Bear / Judge Debate

${debateRows}

## Evidence Pack

| Category | Source | Title | Tickers | Importance | Summary |
|---|---|---|---|---|---|
${evidenceRows(evidence)}

## Paper Account Context

- Equity: ${formatMoney(paperEquity(paper))}
- Cash: ${formatMoney(paper.cash)}
- Daily P/L: ${paperDailyReturnPct(paper).toFixed(2)}%
- Positions: ${paper.positions.map(position => `${position.ticker} ${formatMoney(positionValue(position))}`).join(', ') || 'none'}

## Hermes Boundary

- AI may summarize, compare, and suggest paper research actions.
- AI cannot bypass Phase 4 guardrails.
- No real brokerage execution is connected.
`
}

async function saveMiroFishInferenceReport(input: {
  snapshot: QuantLabSnapshot
  phase: QuantLabBriefPhase
  paper: PaperAccountState
  seed: Awaited<ReturnType<typeof saveMiroFishSeed>>
  inference: MiroFishInference
  evidence: MiroFishEvidenceItem[]
}) {
  const root = resolveKnowledgeRoot()
  const reportDir = mirofishReportDir()
  const universalTopic = universalTopicFromEvidence(input.evidence)
  const baseName = isUniversalMiroFishTopic(universalTopic)
    ? `${todayKey()}-aurora-universal-brain-${input.phase}-${safeMemorySlug(universalTopic)}-mirofish-inference`
    : `${todayKey()}-quant-lab-${input.phase}-mirofish-inference`
  const markdownPath = resolve(reportDir, `${baseName}.md`)
  const jsonPath = resolve(reportDir, `${baseName}.json`)

  if (!markdownPath.startsWith(reportDir) || !jsonPath.startsWith(reportDir)) {
    const err = new Error('Invalid MiroFish report path') as Error & { code?: string }
    err.code = 'invalid_path'
    throw err
  }

  const inferenceWithReport: MiroFishInference = {
    ...input.inference,
    reportPath: markdownPath,
    reportRelativePath: markdownPath.startsWith(root) ? markdownPath.slice(root.length + 1) : markdownPath,
    seedPath: input.seed.path,
    seedRelativePath: input.seed.relativePath,
  }

  await mkdir(reportDir, { recursive: true })
  await writeFile(markdownPath, buildMiroFishInferenceMarkdown({ ...input, inference: inferenceWithReport }), 'utf-8')
  await writeFile(jsonPath, JSON.stringify(inferenceWithReport, null, 2), 'utf-8')

  return inferenceWithReport
}

function edgeCompactText(edge: MiroFishGraphEdgeSummary): string {
  const base = `${edge.source} -> ${edge.target} (${edge.type})`
  return edge.fact ? `${base}: ${edge.fact}` : base
}

function mirofishEvidenceRows(snapshot: QuantLabSnapshot, graphSummary: MiroFishGraphSummary | null): string {
  const tracked = new Map((graphSummary?.trackedNodes || []).map(node => [node.symbol, node]))
  return snapshot.topPicks.slice(0, 10).map((pick) => {
    const node = tracked.get(pick.ticker)
    const related = node?.relatedEdges?.length
      ? node.relatedEdges.slice(0, 3).map(edgeCompactText).join('; ')
      : graphSummary?.sampleEdges
        ?.filter(edge => edge.source.toUpperCase().includes(pick.ticker) || edge.target.toUpperCase().includes(pick.ticker))
        .slice(0, 2)
        .map(edgeCompactText)
        .join('; ') || 'No direct edge in current graph summary.'
    return `| ${pick.ticker} | ${pick.score} | ${pick.action} | ${node?.present ? node.degree : 0} | ${tableEscape(node?.labels?.join(', ') || '-')} | ${tableEscape(node?.summary || pick.reason)} | ${tableEscape(related)} |`
  }).join('\n')
}

function buildMiroFishEvidenceArchiveMarkdown(input: {
  snapshot: QuantLabSnapshot
  phase: QuantLabBriefPhase
  paper: PaperAccountState
  mirofishRun: Awaited<ReturnType<typeof runMiroFishPhase>>
  graphSummary: MiroFishGraphSummary | null
}): string {
  const { snapshot, phase, paper, mirofishRun, graphSummary } = input
  const supportRows = mirofishRun.inference.support.map(item => `- ${item}`).join('\n')
  const opposeRows = mirofishRun.inference.oppose.map(item => `- ${item}`).join('\n')
  const topDegrees = (graphSummary?.trackedNodes || [])
    .filter(node => node.present)
    .sort((a, b) => b.degree - a.degree || a.symbol.localeCompare(b.symbol))
    .slice(0, 8)
    .map(node => `${node.symbol} ${node.degree}`)
    .join(' / ') || 'n/a'
  const universalTopic = universalTopicFromEvidence(mirofishRun.evidence)

  if (isUniversalMiroFishTopic(universalTopic)) {
    return `---
title: Aurora Universal Brain Evidence Snapshot ${phaseLabel(phase)} ${todayKey()}
created: ${new Date().toISOString()}
type: cognitive-journal
status: active
phase: ${phase}
topic: ${yamlString(universalTopic)}
tags:
  - aurora
  - universal-brain
  - mirofish
  - evidence
confidence: ${mirofishRun.inference.confidence}
owner: hermes
source: aurora-universal-brain
---

# Aurora Universal Brain Evidence Snapshot ${phaseLabel(phase)} ${todayKey()}

> Read-only cognitive sandbox. This page preserves the evidence used by Hermes Synthesizer.

## Summary

- Topic: ${universalTopic}
- Phase: ${phase}
- Inference: ${mirofishRun.inference.status} / ${mirofishRun.inference.confidence}
- Evidence count: ${mirofishRun.inference.evidenceCount}
- Seed: ${mirofishRun.seed.relativePath}
- Inference report: ${mirofishRun.inference.reportRelativePath || 'n/a'}
- Graph: ${graphSummary?.ok ? `${graphSummary.graphId || 'latest'} / ${graphSummary.nodeCount} nodes / ${graphSummary.edgeCount} edges / ${graphSummary.source}` : graphSummary?.error || 'unavailable'}
- Top graph degrees: ${topDegrees}

## Supports

${supportRows || '- n/a'}

## Opposes

${opposeRows || '- n/a'}

## Evidence Pack

| Category | Source | Title | Tickers | Importance | Summary |
|---|---|---|---|---|---|
${evidenceRows(mirofishRun.evidence)}

## Boundary

- AI may summarize, compare, and propose reversible next steps.
- AI may update Obsidian memory records.
- AI cannot execute external actions or bypass Approval Gateway.
`
  }

  return `---
title: MiroFish Evidence Snapshot ${phaseLabel(phase)} ${todayKey()}
created: ${new Date().toISOString()}
type: trading-journal
status: active
phase: ${phase}
tags:
  - hermes
  - quant-lab
  - mirofish
  - evidence
  - paper-trading
confidence: ${mirofishRun.inference.confidence}
owner: hermes
source: ${snapshot.source}
---

# MiroFish Evidence Snapshot ${phaseLabel(phase)} ${todayKey()}

> Paper trading research only. No real brokerage order is placed.
> This page preserves the MiroFish support/oppose evidence used by Hermes Quant Lab.

## Summary

- Phase: ${phase}
- Inference: ${mirofishRun.inference.status} / ${mirofishRun.inference.confidence}
- Evidence count: ${mirofishRun.inference.evidenceCount}
- Seed: ${mirofishRun.seed.relativePath}
- Inference report: ${mirofishRun.inference.reportRelativePath || 'n/a'}
- Graph: ${graphSummary?.ok ? `${graphSummary.graphId || 'latest'} / ${graphSummary.nodeCount} nodes / ${graphSummary.edgeCount} edges / ${graphSummary.source}` : graphSummary?.error || 'unavailable'}
- Top graph degrees: ${topDegrees}

## Supports

${supportRows || '- n/a'}

## Opposes

${opposeRows || '- n/a'}

## Top 10 Graph Evidence

| Ticker | Score | Action | Degree | Labels | MiroFish Summary | Related Edges |
|---|---:|---|---:|---|---|---|
${mirofishEvidenceRows(snapshot, graphSummary)}

## Paper Context

- Equity: ${formatMoney(paperEquity(paper))}
- Cash: ${formatMoney(paper.cash)}
- Positions: ${paper.positions.map(position => `${position.ticker} ${formatMoney(positionValue(position))}`).join(', ') || 'none'}
- Guard: ${evaluateTradingRisk(paper, snapshot).status} / ${evaluateTradingRisk(paper, snapshot).reason}

## Boundary

- AI may summarize and compare evidence.
- AI may update paper journal and Obsidian records.
- AI cannot bypass risk controls or place real trades.
`
}

async function saveMiroFishEvidenceArchive(input: {
  snapshot: QuantLabSnapshot
  phase: QuantLabBriefPhase
  paper: PaperAccountState
  mirofishRun: Awaited<ReturnType<typeof runMiroFishPhase>>
  graphSummary: MiroFishGraphSummary | null
}): Promise<MiroFishEvidenceArchive> {
  const root = resolveKnowledgeRoot()
  const evidenceDir = resolve(root, 'trading-journal', 'mirofish-evidence')
  const universalTopic = universalTopicFromEvidence(input.mirofishRun.evidence)
  const baseName = isUniversalMiroFishTopic(universalTopic)
    ? `${todayKey()}-aurora-universal-brain-${input.phase}-${safeMemorySlug(universalTopic)}-mirofish-evidence`
    : `${todayKey()}-quant-lab-${input.phase}-mirofish-evidence`
  const targetPath = resolve(evidenceDir, `${baseName}.md`)
  if (!targetPath.startsWith(evidenceDir)) {
    const err = new Error('Invalid MiroFish evidence archive path') as Error & { code?: string }
    err.code = 'invalid_path'
    throw err
  }

  await mkdir(evidenceDir, { recursive: true })
  await writeFile(targetPath, buildMiroFishEvidenceArchiveMarkdown(input), 'utf-8')

  const topDegrees = (input.graphSummary?.trackedNodes || [])
    .filter(node => node.present)
    .sort((a, b) => b.degree - a.degree || a.symbol.localeCompare(b.symbol))
    .slice(0, 5)
    .map(node => ({ ticker: node.symbol, degree: node.degree }))
  const journalNote = isUniversalMiroFishTopic(universalTopic)
    ? `Aurora Universal Brain evidence archived: ${targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath}; topic ${universalTopic}; ${input.mirofishRun.inference.status}/${input.mirofishRun.inference.confidence}; support: ${input.mirofishRun.inference.support[0] || 'n/a'}; oppose: ${input.mirofishRun.inference.oppose[0] || 'n/a'}.`
    : `MiroFish evidence archived: ${targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath}; ${input.mirofishRun.inference.status}/${input.mirofishRun.inference.confidence}; ${topDegrees.length ? `graph degrees ${topDegrees.map(item => `${item.ticker} d${item.degree}`).join(', ')}` : 'graph summary pending'}; support: ${input.mirofishRun.inference.support[0] || 'n/a'}; oppose: ${input.mirofishRun.inference.oppose[0] || 'n/a'}.`

  return {
    path: targetPath,
    relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
    graphOk: Boolean(input.graphSummary?.ok),
    graphId: input.graphSummary?.graphId,
    graphSource: input.graphSummary?.source,
    journalNote: journalNote.slice(0, 800),
    topDegrees,
  }
}

async function persistMiroFishEvidenceJournal(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState, mirofishRun: Awaited<ReturnType<typeof runMiroFishPhase>>): Promise<MiroFishEvidenceArchive> {
  const graphSummary = await getMiroFishGraphSummary().catch((err): MiroFishGraphSummary => ({
    ok: false,
    backendUrl: resolveMiroFishBackendUrl(),
    checkedAt: new Date().toISOString(),
    source: 'none',
    nodeCount: 0,
    edgeCount: 0,
    nodeTypes: [],
    edgeTypes: [],
    trackedNodes: [],
    topNodes: [],
    sampleEdges: [],
    error: errorMessage(err),
  }))
  const archive = await saveMiroFishEvidenceArchive({ snapshot, phase, paper, mirofishRun, graphSummary })
  if (!isUniversalMiroFishEvidence(mirofishRun.evidence)) {
    addPaperJournal(paper, 'MIROFISH', 'MARK', archive.journalNote)
  }
  return archive
}

function yamlString(value: unknown): string {
  return JSON.stringify(String(value ?? '').replace(/\r?\n/g, ' ').trim())
}

function mirofishMemoryRecordDir(): string {
  return resolve(resolveKnowledgeRoot(), 'MiroFish_Records')
}

function safeMemorySlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'mirofish-verdict'
}

function inferMiroFishFinalVerdict(snapshot: QuantLabSnapshot, inference: MiroFishInference, topicInput?: string): string {
  if (isUniversalMiroFishTopic(normalizeMiroFishTopic(topicInput))) {
    const scenario = inference.debate?.scenarios
    const bullish = scenario ? Math.round(scenario.bullish.probability * 100) : null
    const neutral = scenario ? Math.round(scenario.neutral.probability * 100) : null
    const bearish = scenario ? Math.round(scenario.bearish.probability * 100) : null
    const probabilitySuffix = bullish != null && bearish != null ? ` · favorable ${bullish}% / pilot ${neutral}% / pause ${bearish}%` : ''
    return `SYNTH HOLD${probabilitySuffix}`
  }
  const topPick = snapshot.topPicks[0]
  const action = topPick?.action || snapshot.decision.action || snapshot.decision.conclusion || inference.status
  const scenario = inference.debate?.scenarios
  const bullish = scenario ? Math.round(scenario.bullish.probability * 100) : null
  const bearish = scenario ? Math.round(scenario.bearish.probability * 100) : null
  const tickerPrefix = topPick?.ticker ? `${topPick.ticker} ` : ''
  const probabilitySuffix = bullish != null && bearish != null ? ` · bull ${bullish}% / bear ${bearish}%` : ''
  return `${tickerPrefix}${String(action).toUpperCase()}${probabilitySuffix}`.trim()
}

function inferMiroFishMemoryTopic(snapshot: QuantLabSnapshot, topicInput: string | undefined): string {
  const topic = String(topicInput || '').trim()
  if (topic) return topic
  const topPick = snapshot.topPicks[0]
  if (topPick?.ticker) return `MiroFish debate for ${topPick.ticker}`
  return `MiroFish debate ${todayKey()}`
}

function buildMiroFishLongTermMemoryMarkdown(input: {
  snapshot: QuantLabSnapshot
  phase: QuantLabBriefPhase
  paper: PaperAccountState
  mirofishRun: Awaited<ReturnType<typeof runMiroFishPhase>>
  evidenceArchive: MiroFishEvidenceArchive
  topic?: string
}): { markdown: string; topic: string; verdict: string; date: string } {
  const { snapshot, phase, paper, mirofishRun, evidenceArchive } = input
  const { inference } = mirofishRun
  const debate = inference.debate
  const topic = inferMiroFishMemoryTopic(snapshot, input.topic)
  const universalTopic = isUniversalMiroFishTopic(normalizeMiroFishTopic(input.topic))
  const verdict = inferMiroFishFinalVerdict(snapshot, inference, input.topic)
  const date = new Date().toISOString()
  const sourceLabel = universalTopic ? 'aurora-universal-brain' : snapshot.source
  const topPickRows = universalTopic
    ? mirofishRun.evidence
        .filter(item => item.category === 'topic' || item.category === 'context' || item.category === 'risk')
        .slice(0, 6)
        .map(item => `- ${item.title}: ${item.summary}`)
        .join('\n') || '- No universal topic signals.'
    : snapshot.topPicks.slice(0, 5)
      .map(pick => `- ${pick.ticker}: ${pick.action} / score ${pick.score.toFixed(1)} / risk ${pick.risk} / ${pick.reason}`)
      .join('\n') || '- No ranked candidates.'
  const proRows = debate?.bull?.content
    ? debate.bull.content
    : inference.support.map(item => `- ${item}`).join('\n') || '- No pro arguments captured.'
  const conRows = debate?.bear?.content
    ? debate.bear.content
    : inference.oppose.map(item => `- ${item}`).join('\n') || '- No con arguments captured.'
  const scenarioRows = debate
    ? [
        `- Bullish: ${Math.round(debate.scenarios.bullish.probability * 100)}% confidence ${Math.round(debate.scenarios.bullish.confidence * 100)}% — ${debate.scenarios.bullish.reasoning}`,
        `- Neutral: ${Math.round(debate.scenarios.neutral.probability * 100)}% confidence ${Math.round(debate.scenarios.neutral.confidence * 100)}% — ${debate.scenarios.neutral.reasoning}`,
        `- Bearish: ${Math.round(debate.scenarios.bearish.probability * 100)}% confidence ${Math.round(debate.scenarios.bearish.confidence * 100)}% — ${debate.scenarios.bearish.reasoning}`,
      ].join('\n')
    : '- Scenario judge did not produce structured probabilities.'
  const riskRows = (debate?.key_risks || inference.oppose || [])
    .slice(0, 8)
    .map(item => `- ${item}`)
    .join('\n') || '- No key risks captured.'
  const accountRows = universalTopic
    ? '- Mode: read-only universal cognitive sandbox'
    : [
        `- Paper equity: ${formatMoney(paperEquity(paper))}`,
        `- Paper cash: ${formatMoney(paper.cash)}`,
      ].join('\n')

  const markdown = `---
date: ${yamlString(date)}
topic: ${yamlString(topic)}
question: ${yamlString(topic)}
verdict: ${yamlString(verdict)}
final_verdict: ${yamlString(verdict)}
phase: ${yamlString(phase)}
source: ${yamlString(sourceLabel)}
confidence: ${yamlString(inference.confidence)}
tags: [aurora, mirofish, cognitive-os, extracted-memory]
---

# ${topic}

> ${verdict}

## Context

- Phase: ${phaseLabel(phase)}
- Generated: ${date}
- Source: ${sourceLabel}
- Evidence count: ${mirofishRun.evidence.length}
- Inference report: ${inference.reportRelativePath || 'n/a'}
- Evidence archive: ${evidenceArchive.relativePath}
${accountRows}

### Top Signals

${topPickRows}

## Pro Arguments

${proRows}

## Con Arguments

${conRows}

## Final Synthesis

${scenarioRows}

### Key Risks

${riskRows}

## Memory Governance

This note was written by Aurora OS after the Hermes Synthesizer finalized a read-only MiroFish sandbox verdict. It is a long-term memory record, not a real trade instruction.
`

  return { markdown, topic, verdict, date }
}

async function saveMiroFishLongTermMemory(input: {
  snapshot: QuantLabSnapshot
  phase: QuantLabBriefPhase
  paper: PaperAccountState
  mirofishRun: Awaited<ReturnType<typeof runMiroFishPhase>>
  evidenceArchive: MiroFishEvidenceArchive
  topic?: string
}): Promise<MiroFishLongTermMemoryRecord> {
  const root = resolveKnowledgeRoot()
  const memoryDir = mirofishMemoryRecordDir()
  const { markdown, topic, verdict, date } = buildMiroFishLongTermMemoryMarkdown(input)
  const fileName = `${date.replace(/[:.]/g, '-').slice(0, 23)}-${safeMemorySlug(topic)}.md`
  const targetPath = resolve(memoryDir, fileName)

  if (!targetPath.startsWith(memoryDir)) {
    const err = new Error('Invalid MiroFish memory record path') as Error & { code?: string }
    err.code = 'invalid_path'
    throw err
  }

  await mkdir(memoryDir, { recursive: true })
  await writeFile(targetPath, markdown, 'utf-8')

  return {
    fileName,
    path: targetPath,
    relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
    topic,
    verdict,
    date,
  }
}

function parseMarkdownFrontmatterValue(markdown: string, key: string): string | undefined {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return undefined
  const line = frontmatterMatch[1]
    .split(/\r?\n/)
    .find(item => item.trim().startsWith(`${key}:`))
  if (!line) return undefined
  return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '')
}

function parseEvidenceTopDegrees(value: string | undefined): Array<{ ticker: string; degree: number }> {
  if (!value) return []
  return value
    .split('/')
    .map(item => item.trim())
    .map(item => {
      const match = item.match(/^([A-Z0-9^.=/-]+)\s+(\d+)$/i)
      if (!match) return null
      return { ticker: match[1], degree: Number(match[2]) }
    })
    .filter((item): item is { ticker: string; degree: number } => Boolean(item && Number.isFinite(item.degree)))
}

function normalizeMiroFishTargetTicker(value: unknown): string {
  const ticker = String(value || '').trim().toUpperCase()
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : ''
}

function normalizeMiroFishTopic(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function isUniversalMiroFishTopic(topic: string, targetTicker = ''): boolean {
  if (!topic) return false
  if (targetTicker && topic.toUpperCase() === targetTicker) return false
  if (/^\$?[A-Z]{1,6}(?:[.-][A-Z]{1,3})?$/i.test(topic)) return false
  return true
}

function buildSyntheticTopicTopPick(topic: string): QuantLabSnapshot['topPicks'][number] {
  return {
    ticker: 'TOPIC',
    score: 72,
    action: 'WATCH',
    trend: 'pilot',
    risk: 'M',
    reason: `Universal Brain topic: ${topic}`,
    price: 0,
  } as QuantLabSnapshot['topPicks'][number]
}

function focusSnapshotOnTargetTicker(snapshot: QuantLabSnapshot, targetTicker: string): QuantLabSnapshot {
  if (!targetTicker) return snapshot
  const target = snapshot.topPicks.find(pick => pick.ticker.toUpperCase() === targetTicker)
  if (!target) return snapshot

  snapshot.topPicks = [
    target,
    ...snapshot.topPicks.filter(pick => pick.ticker.toUpperCase() !== targetTicker),
  ] as QuantLabSnapshot['topPicks']
  snapshot.decision = {
    ...snapshot.decision,
    action: `Risk bridge focus: ${target.ticker} ${target.action} ${target.score.toFixed(1)}. ${snapshot.decision.action}`,
  } as QuantLabSnapshot['decision']
  return snapshot
}

function firstBulletAfterHeading(markdown: string, heading: string): string | undefined {
  const index = markdown.indexOf(`## ${heading}`)
  if (index < 0) return undefined
  const section = markdown.slice(index).split(/\n##\s+/)[0]
  const bullet = section.split(/\r?\n/).find(line => line.trim().startsWith('- '))
  return bullet?.trim().replace(/^- /, '')
}

function parseEvidenceArchiveMarkdown(input: { fileName: string; path: string; relativePath: string; markdown: string; statsSize: number; statsMtime: Date }): MiroFishEvidenceArchiveListItem {
  const { fileName, path, relativePath, markdown, statsSize, statsMtime } = input
  const title = parseMarkdownFrontmatterValue(markdown, 'title') || fileName.replace(/\.md$/i, '')
  const createdAt = parseMarkdownFrontmatterValue(markdown, 'created') || statsMtime.toISOString()
  const phase = parseMarkdownFrontmatterValue(markdown, 'phase')
  const confidence = parseMarkdownFrontmatterValue(markdown, 'confidence')
  const graphLine = markdown.match(/^- Graph:\s*(.+)$/m)?.[1]?.trim()
  const graphMatch = graphLine?.match(/^(.+?)\s*\/\s*(\d+)\s+nodes\s*\/\s*(\d+)\s+edges\s*\/\s*(.+)$/i)
  const evidenceCount = Number(markdown.match(/^- Evidence count:\s*(\d+)/m)?.[1])
  const topDegreesLine = markdown.match(/^- Top graph degrees:\s*(.+)$/m)?.[1]?.trim()
  const source = parseMarkdownFrontmatterValue(markdown, 'source')
  const status = parseMarkdownFrontmatterValue(markdown, 'status')
  const support = firstBulletAfterHeading(markdown, 'Supports')
  const oppose = firstBulletAfterHeading(markdown, 'Opposes')
  const summary = [
    support ? `Support: ${support}` : '',
    oppose ? `Oppose: ${oppose}` : '',
  ].filter(Boolean).join(' / ') || graphLine || 'Evidence archive saved.'

  return {
    fileName,
    path,
    relativePath,
    title,
    createdAt,
    updatedAt: statsMtime.toISOString(),
    phase: phase === 'afterclose' ? 'afterclose' : phase === 'premarket' ? 'premarket' : undefined,
    status,
    confidence: confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : undefined,
    source,
    graphOk: Boolean(graphMatch),
    graphId: graphMatch?.[1]?.trim(),
    graphSource: graphMatch?.[4]?.trim(),
    nodeCount: graphMatch ? Number(graphMatch[2]) : undefined,
    edgeCount: graphMatch ? Number(graphMatch[3]) : undefined,
    evidenceCount: Number.isFinite(evidenceCount) ? evidenceCount : undefined,
    topDegrees: parseEvidenceTopDegrees(topDegreesLine),
    support,
    oppose,
    summary,
    size: statsSize,
  }
}

async function listMiroFishEvidenceArchives(limit = 24): Promise<{ ok: boolean; entries: MiroFishEvidenceArchiveListItem[]; path: string; relativePath: string; updatedAt: string }> {
  const root = resolveKnowledgeRoot()
  const evidenceDir = resolve(root, 'trading-journal', 'mirofish-evidence')
  const relativePath = evidenceDir.startsWith(root) ? evidenceDir.slice(root.length + 1) : evidenceDir

  if (!existsSync(evidenceDir)) {
    return { ok: true, entries: [], path: evidenceDir, relativePath, updatedAt: new Date().toISOString() }
  }

  const fileNames = (await readdir(evidenceDir))
    .filter(fileName => fileName.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, clamp(limit, 1, 100))

  const entries = (await Promise.all(fileNames.map(async (fileName) => {
    const targetPath = resolve(evidenceDir, basename(fileName))
    if (!targetPath.startsWith(evidenceDir)) return null
    const [markdown, statsResult] = await Promise.all([
      readFile(targetPath, 'utf-8'),
      stat(targetPath),
    ])
    return parseEvidenceArchiveMarkdown({
      fileName,
      path: targetPath,
      relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
      markdown,
      statsSize: statsResult.size,
      statsMtime: statsResult.mtime,
    })
  })))
    .filter((entry): entry is MiroFishEvidenceArchiveListItem => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return { ok: true, entries, path: evidenceDir, relativePath, updatedAt: new Date().toISOString() }
}

function mirofishMemoryRecordDirs(): string[] {
  const root = resolveKnowledgeRoot()
  return Array.from(new Set([
    resolve(root, 'MiroFish_Records'),
    resolve(root, 'raw', 'mirofish', 'reports'),
    resolve(root, 'trading-journal', 'mirofish-evidence'),
  ]))
}

function parseMarkdownTags(markdown: string): string[] {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return []
  const lines = frontmatterMatch[1].split(/\r?\n/)
  const tagsLine = lines.find(line => line.trim().startsWith('tags:'))
  const tagsIndex = tagsLine ? lines.indexOf(tagsLine) : -1
  if (tagsIndex < 0) return []

  const inline = tagsLine?.slice(tagsLine.indexOf(':') + 1).trim()
  if (inline && inline !== '[]') {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(tag => tag.trim().replace(/^["']|["']$/g, '').replace(/^#/, ''))
      .filter(Boolean)
      .slice(0, 8)
  }

  const blockTags: string[] = []
  for (const line of lines.slice(tagsIndex + 1)) {
    if (/^[A-Za-z0-9_-]+:/.test(line.trim())) break
    const match = line.match(/^\s*-\s+(.+)$/)
    if (match) blockTags.push(match[1].trim().replace(/^#/, ''))
  }
  return blockTags.slice(0, 8)
}

function firstMarkdownLine(markdown: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = markdown.match(pattern)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

function sectionSnippet(markdown: string, headings: string[], fallback = ''): string {
  for (const heading of headings) {
    const index = markdown.search(new RegExp(`^##\\s+${heading}\\s*$`, 'im'))
    if (index < 0) continue
    const section = markdown.slice(index).split(/\n##\s+/)[0] || ''
    const content = section
      .split(/\r?\n/)
      .slice(1)
      .map(line => line.replace(/^[-*>#\s]+/, '').trim())
      .filter(Boolean)
      .join(' ')
    if (content) return content.slice(0, 280)
  }
  return fallback
}

function parseMiroFishMemoryRecord(input: { fileName: string; path: string; relativePath: string; markdown: string; statsSize: number; statsMtime: Date }): MiroFishMemoryRecord | null {
  const { fileName, path, relativePath, markdown, statsSize, statsMtime } = input
  const title = parseMarkdownFrontmatterValue(markdown, 'title') ||
    firstMarkdownLine(markdown, [/^#\s+(.+)$/m]) ||
    fileName.replace(/\.md$/i, '')
  const question = parseMarkdownFrontmatterValue(markdown, 'question') ||
    firstMarkdownLine(markdown, [
      /^simulation_requirement:\s*\|\s*\n\s*(.+)$/m,
      /^-\s*(?:Question|問題|Prompt|Intent):\s*(.+)$/im,
      /^>\s*(.+)$/m,
    ]) ||
    title
  const date = parseMarkdownFrontmatterValue(markdown, 'date') ||
    parseMarkdownFrontmatterValue(markdown, 'created') ||
    parseMarkdownFrontmatterValue(markdown, 'updated') ||
    statsMtime.toISOString()
  const finalVerdict = parseMarkdownFrontmatterValue(markdown, 'final_verdict') ||
    parseMarkdownFrontmatterValue(markdown, 'verdict') ||
    parseMarkdownFrontmatterValue(markdown, 'action') ||
    firstMarkdownLine(markdown, [
      /^-\s*(?:Action|Final Action|Conclusion|Status):\s*(.+)$/im,
      /^-\s*(?:Inference|Confidence):\s*(.+)$/im,
    ]) ||
    sectionSnippet(markdown, ['Hermes Decision', 'Bull / Bear / Judge Debate', 'Summary'], 'Archived MiroFish memory')
  const summary = sectionSnippet(markdown, ['Summary', 'Supports', 'Status'], finalVerdict)
  const tags = parseMarkdownTags(markdown)

  if (!/mirofish|quant-lab|simulation|evidence|scenario/i.test([title, question, finalVerdict, tags.join(' ')].join(' '))) {
    return null
  }

  return {
    id: Buffer.from(relativePath).toString('base64url'),
    fileName,
    path,
    relativePath,
    title: title.slice(0, 140),
    question: question.slice(0, 220),
    date,
    finalVerdict: finalVerdict.slice(0, 220),
    summary: summary.slice(0, 320),
    source: relativePath.includes('MiroFish_Records')
      ? 'MiroFish_Records'
      : relativePath.includes('mirofish-evidence')
        ? 'MiroFish Evidence'
        : 'MiroFish Reports',
    tags,
    size: statsSize,
    updatedAt: statsMtime.toISOString(),
  }
}

async function listMarkdownFilesShallow(dir: string, root: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const targetPath = resolve(dir, entry.name)
    if (!targetPath.startsWith(root)) continue
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(targetPath)
    }
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const nested = await readdir(targetPath, { withFileTypes: true }).catch(() => [])
      nested
        .filter(child => child.isFile() && child.name.toLowerCase().endsWith('.md'))
        .forEach(child => {
          const childPath = resolve(targetPath, child.name)
          if (childPath.startsWith(root)) files.push(childPath)
        })
    }
  }
  return files
}

async function listMiroFishMemoryRecords(limit = 80): Promise<{ ok: boolean; records: MiroFishMemoryRecord[]; directories: string[]; path: string; relativePath: string; updatedAt: string }> {
  const root = resolveKnowledgeRoot()
  const directories = mirofishMemoryRecordDirs()
  const files = (await Promise.all(directories.map(dir => listMarkdownFilesShallow(dir, root)))).flat()
  const uniqueFiles = Array.from(new Set(files)).slice(0, 500)

  const records = (await Promise.all(uniqueFiles.map(async (targetPath) => {
    if (!targetPath.startsWith(root)) return null
    const [markdown, statsResult] = await Promise.all([
      readFile(targetPath, 'utf-8').catch(() => ''),
      stat(targetPath).catch(() => null),
    ])
    if (!markdown || !statsResult) return null
    return parseMiroFishMemoryRecord({
      fileName: basename(targetPath),
      path: targetPath,
      relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
      markdown,
      statsSize: statsResult.size,
      statsMtime: statsResult.mtime,
    })
  })))
    .filter((record): record is MiroFishMemoryRecord => Boolean(record))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, clamp(limit, 1, 200))

  const memoryDir = directories[0]
  return {
    ok: true,
    records,
    directories,
    path: memoryDir,
    relativePath: memoryDir.startsWith(root) ? memoryDir.slice(root.length + 1) : memoryDir,
    updatedAt: new Date().toISOString(),
  }
}

async function runMiroFishPhase(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState, submitBackend = false, topic = '') {
  const universalTopic = isUniversalMiroFishTopic(topic)
  const evidence = universalTopic
    ? await buildUniversalMiroFishEvidencePack(topic, phase)
    : await buildMiroFishEvidencePack(snapshot, phase, paper)
  const seed = await saveMiroFishSeed(snapshot, phase, paper, evidence)
  const debate = await runMiroFishDebate(buildMiroFishDebateEvidencePack(snapshot, phase, paper, evidence, universalTopic ? topic : ''))
  const localInference = universalTopic
    ? buildUniversalMiroFishInference(topic, phase, evidence, debate)
    : applyMiroFishDebateToInference(buildLocalMiroFishInference(snapshot, phase, paper, evidence), debate)
  const backendInference = submitBackend ? await submitMiroFishSeedToBackend(seed, phase) : await probeMiroFishBackend()
  const inference: MiroFishInference = {
    ...localInference,
    ...('ok' in backendInference
      ? {
          backendUrl: backendInference.url,
          backendStatus: backendInference.status,
          status: backendInference.ok ? 'backend_available' : localInference.status,
          error: sanitizeMiroFishGatewayText(backendInference.error),
        }
      : backendInference),
    support: localInference.support,
    oppose: localInference.oppose,
    neutral: localInference.neutral,
    confidence: localInference.confidence,
    evidenceCount: evidence.length,
    seedPath: seed.path,
    seedRelativePath: seed.relativePath,
    updatedAt: new Date().toISOString(),
  }
  const report = await saveMiroFishInferenceReport({ snapshot, phase, paper, seed, inference, evidence })
  return { seed, evidence, inference: report }
}

function buildBriefMarkdown(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState, mirofishRun?: Awaited<ReturnType<typeof runMiroFishPhase>>, evidenceArchive?: MiroFishEvidenceArchive): string {
  const label = phaseLabel(phase)
  const pulseRows = snapshot.marketPulse.map(item => `| ${item.label} | ${item.value} |`).join('\n')
  const topRows = snapshot.topPicks
    .map(pick => {
      const score = (pick as typeof pick & {
        scoreBreakdown?: {
          quality: number
          momentum: number
          earnings?: number
          liquidity?: number
          regime: number
          risk: number
          confidence: string
        }
      }).scoreBreakdown
      return `| ${pick.ticker} | ${pick.score} | ${score?.quality ?? 'n/a'} | ${score?.momentum ?? 'n/a'} | ${score?.earnings ?? 'n/a'} | ${score?.liquidity ?? 'n/a'} | ${score?.regime ?? 'n/a'} | ${score?.risk ?? 'n/a'} | ${score?.confidence ?? 'n/a'} | ${pick.action} | ${pick.risk} | ${pick.trend} | ${pick.price} | ${tableEscape(pick.reason)} |`
    })
    .join('\n')

  return `---
title: Hermes Quant Lab ${label}簡報 ${todayKey()}
created: ${new Date().toISOString()}
type: trading-brief
status: draft
phase: ${phase}
tags:
  - hermes
  - quant-lab
  - market-brief
confidence: medium
owner: hermes
source: ${snapshot.source}
---

# Hermes Quant Lab ${label}簡報 ${todayKey()}

> Paper trading only. This is a research brief, not financial advice or a brokerage order.
> Data source: ${snapshot.source} / ${snapshot.generatedAt}
> Data health: quotes ${snapshot.dataHealth.quoteCoverage}, quote source ${snapshot.dataHealth.quoteSource}, backtest ${snapshot.dataHealth.backtestSource}

## Market Pulse

| Indicator | Value |
|---|---:|
${pulseRows}

## Hermes Decision

- 結論：${snapshot.decision.conclusion}
- 動作：${snapshot.decision.action}
- 失效條件：${snapshot.decision.invalidation}

## Top 10 Candidates

| Ticker | Score | Quality | Momentum | Earnings | Liquidity | Regime | Risk Adj | Confidence | Action | Risk | Trend | Price | Reason |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|---|
${topRows}

## Paper Account KPI

| KPI | Value |
|---|---:|
${paperSummaryRows(paper, snapshot)}

## Paper Positions

| Ticker | Shares | Avg Cost | Last Price | Value | P/L |
|---|---:|---:|---:|---:|---:|
${paperPositionRows(paper)}

## Paper Trading Journal

| Time | Ticker | Action | Note |
|---|---|---|---|
${paperJournalRows(paper)}

## Decision Journal

| Ticker | Decision | Why / Why Not | Risk / Source | Next Validation |
|---|---|---|---|---|
${decisionJournalRows(snapshot)}

## Tomorrow Validation

${tomorrowValidationRows(snapshot, paper)}

## MiroFish Seed

${mirofishRun ? `- Status: ${mirofishRun.inference.status}\n- Seed: ${mirofishRun.seed.relativePath}\n- Report: ${mirofishRun.inference.reportRelativePath || 'n/a'}\n- Confidence: ${mirofishRun.inference.confidence}\n- Backend: ${mirofishRun.inference.backendStatus || 'not checked'}\n- Requirement: ${mirofishRun.seed.requirement}` : '- Status: not generated in this run'}

## MiroFish Evidence Archive

${evidenceArchive ? `- Path: ${evidenceArchive.relativePath}\n- Graph: ${evidenceArchive.graphOk ? `${evidenceArchive.graphId || 'latest'} / ${evidenceArchive.graphSource || 'unknown'}` : 'unavailable'}\n- Top degrees: ${evidenceArchive.topDegrees.length ? evidenceArchive.topDegrees.map(item => `${item.ticker} d${item.degree}`).join(' / ') : 'n/a'}\n- Journal: ${tableEscape(evidenceArchive.journalNote)}` : '- Status: not archived in this run'}

### MiroFish Supports

${mirofishRun ? mirofishRun.inference.support.map(item => `- ${item}`).join('\n') : '- n/a'}

### MiroFish Opposes

${mirofishRun ? mirofishRun.inference.oppose.map(item => `- ${item}`).join('\n') : '- n/a'}

## Operating Rules

${snapshot.riskRules.map(rule => `- ${rule}`).join('\n')}

## Next Check

- ${phase === 'premarket' ? '開盤後觀察是否符合高分候選方向，避免追高。' : '收盤後檢查候選股是否仍符合隔日觀察條件，並更新交易日記。'}
`
}

function buildBriefTelegramText(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState, mirofishRun?: Awaited<ReturnType<typeof runMiroFishPhase>>): string {
  const label = phaseLabel(phase)
  return `HERMES Quant Lab ${label}簡報 ${todayKey()}

Paper trading only, no real orders.
Source: ${snapshot.source} | Quotes ${snapshot.dataHealth.quoteCoverage} | Backtest ${snapshot.dataHealth.backtestSource}

Market:
SPY ${getPulseValue(snapshot, 'SPY')} | QQQ ${getPulseValue(snapshot, 'QQQ')} | VIX ${getPulseValue(snapshot, 'VIX')} | 10Y ${getPulseValue(snapshot, '10Y')} | Regime ${getPulseValue(snapshot, 'Regime')}

Hermes:
${snapshot.decision.conclusion}

Action:
${snapshot.decision.action}

Top 10:
${formatTopList(snapshot, 10)}

${paperTelegramSummary(paper, snapshot)}

MiroFish:
${mirofishRun ? `${mirofishRun.inference.status} / ${mirofishRun.inference.confidence}; seed ${mirofishRun.seed.relativePath}; report ${mirofishRun.inference.reportRelativePath || 'n/a'}` : 'Seed not generated.'}
Support: ${mirofishRun?.inference.support[0] || 'n/a'}
Oppose: ${mirofishRun?.inference.oppose[0] || 'n/a'}

Risk:
${snapshot.decision.invalidation}`
}

interface WeeklyBriefSource {
  fileName: string
  relativePath: string
  mtimeMs: number
  title: string
  phase: string
  topTickers: string[]
}

async function listWeeklyBriefSources(limit = 12): Promise<WeeklyBriefSource[]> {
  const root = resolveKnowledgeRoot()
  const journalDir = resolve(root, 'trading-journal')
  if (!existsSync(journalDir)) return []

  const files = await readdir(journalDir)
  const rows = await Promise.all(files
    .filter(file => /quant-lab-(premarket|afterclose)\.md$/i.test(file))
    .map(async fileName => {
      const targetPath = resolve(journalDir, fileName)
      const info = await stat(targetPath)
      const content = await readFile(targetPath, 'utf-8').catch(() => '')
      const title = content.match(/^#\s+(.+)$/m)?.[1] || fileName
      const phase = content.match(/^phase:\s*(.+)$/m)?.[1] || (fileName.includes('afterclose') ? 'afterclose' : 'premarket')
      const topSection = content.split('## Top 10 Candidates')[1]?.split('\n## ')[0] || ''
      const topTickers = Array.from(topSection.matchAll(/^\|\s*([A-Z][A-Z0-9.-]{0,9})\s*\|/gm))
        .map(match => match[1])
        .filter(ticker => ticker !== 'Ticker')
        .slice(0, 10)
      return {
        fileName,
        relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
        mtimeMs: info.mtimeMs,
        title,
        phase,
        topTickers,
      }
    }))

  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

function weeklyTickerFrequencyRows(sources: WeeklyBriefSource[]): string {
  const counts = new Map<string, number>()
  sources.forEach(source => source.topTickers.forEach(ticker => incrementCount(counts, ticker)))
  const rows = topCountRows(counts, 12)
  if (!rows.length) return '| - | - |'
  return rows.map(row => `| ${row.label} | ${row.count} |`).join('\n')
}

function weeklyBriefSourceRows(sources: WeeklyBriefSource[]): string {
  if (!sources.length) return '| - | - | - |'
  return sources
    .map(source => `| ${tableEscape(source.fileName)} | ${tableEscape(source.phase)} | ${source.topTickers.join(' / ') || '-'} |`)
    .join('\n')
}

function buildWeeklySummaryMarkdown(snapshot: QuantLabSnapshot, paper: PaperAccountState, sources: WeeklyBriefSource[]): string {
  const guard = evaluateTradingRisk(paper, snapshot)
  return `---
title: Hermes Quant Lab 每週總結 ${todayKey()}
created: ${new Date().toISOString()}
type: trading-weekly-summary
status: draft
tags:
  - hermes
  - quant-lab
  - weekly-summary
confidence: medium
owner: hermes
source: ${snapshot.source}
---

# Hermes Quant Lab 每週總結 ${todayKey()}

> Paper trading only. This is a research summary, not financial advice or a brokerage order.
> Universe: ${snapshot.dataHealth.universeSize || 'n/a'} symbols. Data: ${snapshot.dataHealth.quoteSource} / ${snapshot.dataHealth.quoteCoverage}.

## 本週結論

- 市場：SPY ${getPulseValue(snapshot, 'SPY')} / QQQ ${getPulseValue(snapshot, 'QQQ')} / VIX ${getPulseValue(snapshot, 'VIX')} / 10Y ${getPulseValue(snapshot, '10Y')} / 狀態 ${getPulseValue(snapshot, 'Regime')}
- 今日 Top 10：${snapshot.topPicks.map(pick => `${pick.ticker} ${pick.score} ${pick.action}`).join(' / ')}
- 風控：${guard.status} / ${guard.reason}
- 紙上帳戶：Equity ${formatMoney(paperEquity(paper))}，Return ${paperReturnPct(paper).toFixed(2)}%，Max DD ${paperDrawdownPct(paper).toFixed(2)}%，持倉 ${paper.positions.map(position => position.ticker).join(' / ') || 'none'}

## 今日全域掃描 Top 10

${formatTopList(snapshot, 10)}

## 本週反覆出現候選

| Ticker | Appearances |
|---|---:|
${weeklyTickerFrequencyRows(sources)}

## 使用的每日簡報

| File | Phase | Top 10 |
|---|---|---|
${weeklyBriefSourceRows(sources)}

## 下週觀察

- 保留高分且風險非 H 的標的，等待趨勢、量能與財報代理訊號同步。
- 若 VIX 升破 20、QQQ 跌破 20MA、10Y 快速上行或資料源降級，停止新增紙上買入。
- 所有動作維持紙上交易與日記追蹤，不送出真實券商委託。
`
}

function buildWeeklySummaryTelegramText(snapshot: QuantLabSnapshot, paper: PaperAccountState, sources: WeeklyBriefSource[]): string {
  const guard = evaluateTradingRisk(paper, snapshot)
  const repeated = weeklyTickerFrequencyRows(sources)
    .split(/\r?\n/)
    .filter(line => line.startsWith('| ') && !line.includes('---') && !line.includes('Ticker'))
    .slice(0, 5)
    .map(line => line.split('|').map(part => part.trim()).filter(Boolean).join(' x'))
    .join(' / ') || 'n/a'

  return `HERMES Quant Lab 每週總結 ${todayKey()}

Paper trading only, no real orders.
Universe ${snapshot.dataHealth.universeSize || 'n/a'} | Source ${snapshot.source} | Quotes ${snapshot.dataHealth.quoteCoverage}

Market: SPY ${getPulseValue(snapshot, 'SPY')} | QQQ ${getPulseValue(snapshot, 'QQQ')} | VIX ${getPulseValue(snapshot, 'VIX')} | 10Y ${getPulseValue(snapshot, '10Y')} | Regime ${getPulseValue(snapshot, 'Regime')}

Today Top 10:
${formatTopList(snapshot, 10)}

Repeated this week:
${repeated}

Paper: Equity ${formatMoney(paperEquity(paper))}; P/L ${paperReturnPct(paper).toFixed(2)}%; DD ${paperDrawdownPct(paper).toFixed(2)}%; Guard ${guard.status}: ${guard.reason}

Next week: keep paper-only validation; no real brokerage orders.`
}

function buildPaperDailyMarkdown(snapshot: QuantLabSnapshot, paper: PaperAccountState, reason: string): string {
  const guard = evaluateTradingRisk(paper, snapshot)
  const priceRows = paperPriceBook(snapshot)
    .slice(0, 15)
    .map(item => `| ${item.ticker} | ${formatMoney(item.price)} | ${tableEscape(item.trend)} | ${item.source} | ${item.quoteSource} |`)
    .join('\n') || '| - | - | - | - | - |'

  return `---
title: Hermes Quant Lab Paper Account ${todayKey()}
created: ${new Date().toISOString()}
type: trading-journal
status: active
tags:
  - hermes
  - quant-lab
  - paper-trading
confidence: medium
owner: hermes
source: ${snapshot.source}
---

# Hermes Quant Lab Paper Account ${todayKey()}

> Paper trading only. No real brokerage order is placed.
> Update reason: ${tableEscape(reason)}
> Data source: ${snapshot.source} / ${snapshot.generatedAt}
> Data health: ${snapshot.dataHealth.status || 'OK'}, quotes ${snapshot.dataHealth.quoteCoverage}, quote source ${snapshot.dataHealth.quoteSource}, latency ${snapshot.dataHealth.quoteLatencyMs ?? 'n/a'}ms, backtest ${snapshot.dataHealth.backtestSource}

## Paper KPI

| KPI | Value |
|---|---:|
${paperSummaryRows(paper, snapshot)}

## Current Positions

| Ticker | Shares | Avg Cost | Last Price | Value | P/L |
|---|---:|---:|---:|---:|---:|
${paperPositionRows(paper)}

## Risk State

- Guard: ${guard.status} / ${guard.reason}
- Prohibited: ${guard.prohibited.length ? guard.prohibited.map(tableEscape).join('; ') : 'none'}
- Daily P/L: ${paperDailyReturnPct(paper).toFixed(2)}%
- Max drawdown: ${paperDrawdownPct(paper).toFixed(2)}%
- Consecutive realized losses: ${ensurePaperRiskState(paper).consecutiveLosses}
- Paused until: ${ensurePaperRiskState(paper).pauseNewBuysUntil || 'none'}

| Check | Status | Value | Reason |
|---|---|---:|---|
${riskCheckRows(guard)}

## Recent Journal

| Time | Ticker | Action | Note |
|---|---|---|---|
${paperJournalRows(paper)}

## Latest Price Book

| Ticker | Price | Trend | Price Source | Quote Source |
|---|---:|---:|---|---|
${priceRows}

## Current Hermes Decision

- Conclusion: ${snapshot.decision.conclusion}
- Action: ${snapshot.decision.action}
- Invalidation: ${snapshot.decision.invalidation}

## Operating Rules

${snapshot.riskRules.map(rule => `- ${rule}`).join('\n')}
`
}

async function savePaperDailyReport(snapshot: QuantLabSnapshot, paper: PaperAccountState, reason: string) {
  return saveMarkdownToJournal(buildPaperDailyMarkdown(snapshot, paper, reason), `${todayKey()}-quant-lab-paper.md`)
}

async function saveTextToJournal(content: string, fileName: string | undefined, allowedExtensions: string[]) {
  const root = resolveKnowledgeRoot()
  const journalDir = resolve(root, 'trading-journal')
  const targetPath = resolve(journalDir, safeJournalFileName(fileName, allowedExtensions))

  if (!targetPath.startsWith(journalDir)) {
    const err = new Error('Invalid report path') as Error & { code?: string }
    err.code = 'invalid_path'
    throw err
  }

  await mkdir(journalDir, { recursive: true })
  await writeFile(targetPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8')

  return {
    path: targetPath,
    relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
  }
}

async function saveMarkdownToJournal(content: string, fileName: string | undefined) {
  return saveTextToJournal(content, fileName, ['.md'])
}

async function saveReportToJournal(content: string, fileName: string | undefined) {
  return saveTextToJournal(content, fileName, ['.md', '.csv'])
}

function frontmatterValue(content: string, key: string): string {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] || ''
  const match = frontmatter.match(new RegExp(`^${key}:\\s*\"?([^\"\\n]+)\"?\\s*$`, 'm'))
  return (match?.[1] || '').trim()
}

function auditSnapshotSummary(content: string): string {
  return (content.match(/^>\s*(.+)$/m)?.[1] || content.match(/^#\s+(.+)$/m)?.[1] || 'MiroFish audit snapshot.')
    .replace(/\s+/g, ' ')
    .trim()
}

function auditSnapshotSignal(content: string, fallback: string): string {
  const title = frontmatterValue(content, 'title') || fallback
  return title.replace(/^MiroFish Audit Snapshot\s*-\s*/i, '').trim() || fallback
}

function galleryEntryKind(fileName: string): 'audit-snapshot' | 'batch-markdown' | 'batch-csv' | 'compare-markdown' {
  if (/^mirofish-compare-.+\.md$/i.test(fileName)) return 'compare-markdown'
  if (/^mirofish-batch-.+\.csv$/i.test(fileName)) return 'batch-csv'
  if (/^mirofish-batch-.+\.md$/i.test(fileName)) return 'batch-markdown'
  return 'audit-snapshot'
}

function galleryCategoryLabel(kind: ReturnType<typeof galleryEntryKind>): string {
  if (kind === 'compare-markdown') return 'Compare Report'
  if (kind === 'batch-csv') return 'Batch CSV'
  if (kind === 'batch-markdown') return 'Batch Markdown'
  return 'Audit Snapshot'
}

function batchCsvSummary(content: string): string {
  const lines = content.trim().split(/\r?\n/).filter(Boolean)
  const rows = lines.slice(1)
  const tickers = rows
    .map(row => row.match(/^"?([^",]+)"?/)?.[1])
    .filter(Boolean)
    .slice(0, 4)
    .join(', ')
  return `Batch CSV export with ${rows.length} candidate${rows.length === 1 ? '' : 's'}${tickers ? `: ${tickers}` : ''}.`
}

function galleryEntrySummary(kind: ReturnType<typeof galleryEntryKind>, content: string): string {
  if (kind === 'batch-csv') return batchCsvSummary(content)
  return auditSnapshotSummary(content)
}

function galleryEntrySignal(kind: ReturnType<typeof galleryEntryKind>, content: string, fileName: string): string {
  if (kind === 'compare-markdown') {
    const title = frontmatterValue(content, 'title') || content.match(/^#\s+(.+)$/m)?.[1] || fileName
    return title.replace(/^MiroFish Snapshot Compare\s*-\s*/i, '').trim() || 'Compare Report'
  }
  if (kind === 'batch-csv') return 'Batch CSV'
  if (kind === 'batch-markdown') return frontmatterValue(content, 'scenario') || 'Batch Report'
  return auditSnapshotSignal(content, fileName)
}

async function listMiroFishAuditSnapshots(limit = 12) {
  const root = resolveKnowledgeRoot()
  const journalDir = resolve(root, 'trading-journal')
  if (!existsSync(journalDir)) {
    return {
      entries: [],
      path: journalDir,
      relativePath: journalDir.startsWith(root) ? journalDir.slice(root.length + 1) : journalDir,
    }
  }

  const fileNames = (await readdir(journalDir))
    .filter(fileName => /^mirofish-(?:audit-[a-z0-9.-]+\.md|batch-[a-z0-9.-]+\.(?:md|csv)|compare-[a-z0-9.-]+\.md)$/i.test(fileName))

  const rows = await Promise.all(fileNames.map(async (fileName) => {
    const targetPath = resolve(journalDir, fileName)
    if (!targetPath.startsWith(journalDir)) return null

    const [info, rawContent] = await Promise.all([
      stat(targetPath),
      readFile(targetPath, 'utf-8').catch(() => ''),
    ])
    const content = rawContent.slice(0, 24000)
    const kind = galleryEntryKind(fileName)
    const title = frontmatterValue(content, 'title') || content.match(/^#\s+(.+)$/m)?.[1] || fileName
    return {
      fileName,
      path: targetPath,
      relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
      kind,
      categoryLabel: galleryCategoryLabel(kind),
      extension: extname(fileName).toLowerCase().replace(/^\./, ''),
      title,
      summary: galleryEntrySummary(kind, content),
      signal: galleryEntrySignal(kind, content, fileName),
      confidence: frontmatterValue(content, 'confidence') || 'n/a',
      driftScore: frontmatterValue(content, 'drift_score') || 'n/a',
      createdAt: frontmatterValue(content, 'date') || new Date(info.mtimeMs).toISOString(),
      mtimeMs: info.mtimeMs,
      content,
    }
  }))

  return {
    entries: rows
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit),
    path: journalDir,
    relativePath: journalDir.startsWith(root) ? journalDir.slice(root.length + 1) : journalDir,
  }
}

function isTerminalActionType(value: unknown): value is TerminalActionType {
  return value === 'DRAW_LINE' ||
    value === 'CHANGE_TICKER' ||
    value === 'SIMULATE_TRADE' ||
    value === 'ADD_JOURNAL' ||
    value === 'SET_ALERT'
}

function actionAuditPath(): { root: string; path: string; relativePath: string } {
  const root = resolveKnowledgeRoot()
  const auditDir = resolve(root, 'trading-journal', 'action-audit')
  const fileName = safeJsonlFileName(`${todayKey()}-quant-actions.jsonl`)
  const targetPath = resolve(auditDir, fileName)
  return {
    root,
    path: targetPath,
    relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
  }
}

function quantNotificationPath(date = todayKey()): { root: string; path: string; relativePath: string } {
  const root = resolveKnowledgeRoot()
  const notificationDir = resolve(root, 'trading-journal', 'notifications')
  const fileName = safeJsonlFileName(`${date}-quant-notifications.jsonl`)
  const targetPath = resolve(notificationDir, fileName)
  return {
    root,
    path: targetPath,
    relativePath: targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath,
  }
}

function readQuantNotificationEntries(limit = 120): QuantNotificationEntry[] {
  const notification = quantNotificationPath()
  if (!existsSync(notification.path)) return []

  return readFileSync(notification.path, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map(line => {
      try {
        return scrubSensitiveValue(JSON.parse(line)) as QuantNotificationEntry
      } catch {
        return null
      }
    })
    .filter((entry): entry is QuantNotificationEntry => Boolean(entry))
    .reverse()
}

async function appendQuantNotification(entry: QuantNotificationEntry) {
  const notification = quantNotificationPath()
  const targetDir = resolve(notification.path, '..')
  if (!notification.path.startsWith(targetDir)) {
    const err = new Error('Invalid notification path') as Error & { code?: string }
    err.code = 'invalid_path'
    throw err
  }

  await mkdir(targetDir, { recursive: true })
  await appendFile(notification.path, `${JSON.stringify(entry)}\n`, 'utf-8')
  return notification
}

function normalizeNotificationSeverity(value: unknown): QuantNotificationSeverity {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low'
    ? value
    : 'medium'
}

function isImportantNotification(severity: QuantNotificationSeverity): boolean {
  return severity === 'high' || severity === 'critical'
}

function notificationSeverityRank(severity: QuantNotificationSeverity): number {
  if (severity === 'critical') return 4
  if (severity === 'high') return 3
  if (severity === 'medium') return 2
  return 1
}

function compactDedupePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'event'
}

function hasSentNotification(dedupeKey: string): boolean {
  return readQuantNotificationEntries(500)
    .some(entry => entry.dedupeKey === dedupeKey && entry.status === 'sent')
}

function buildPremiumQuantTelegramAlert(entry: QuantNotificationEntry): TelegramPremiumQuantAlert {
  const riskBlock = buildPremiumRiskBlock(entry)
  return {
    ticker: inferNotificationTicker(entry),
    action: inferNotificationAction(entry),
    score: inferNotificationScore(entry),
    price: inferNotificationPrice(entry),
    insight: buildPremiumInsight(entry, Boolean(riskBlock)),
    riskBlock,
  }
}

function buildPremiumInsight(entry: QuantNotificationEntry, hasRiskBlock: boolean): string {
  const headline = entry.title.trim()
  const body = cleanNotificationText(entry.body)
  const severityLine = `重要度 ${entry.severity.toUpperCase()}；來源 ${entry.source}；此訊息僅限紙上交易與研究觀察。`
  if (hasRiskBlock) {
    return [
      headline,
      severityLine,
      'Hermes 已將這筆訊號交由風控層檢查。若資料品質、波動或部位集中度不理想，系統會先保護帳戶，而不是追價行動。',
    ].join('\n')
  }
  return [
    headline,
    body,
    severityLine,
  ].filter(Boolean).join('\n')
}

function buildPremiumRiskBlock(entry: QuantNotificationEntry): string | null {
  const shouldShow =
    entry.kind === 'risk_guard' ||
    /(?:risk|guard|block|blocked|halt|風控|攔截|禁止|降級|防禦|回撤|虧損)/i.test(`${entry.title}\n${entry.body}`)
  if (!shouldShow) return null
  return cleanNotificationText(entry.body) || entry.title
}

function inferNotificationTicker(entry: QuantNotificationEntry): string {
  const metadataTicker = metadataString(entry.metadata, 'ticker')
  if (metadataTicker) return metadataTicker
  const text = `${entry.title}\n${entry.body}`
  const hashMatch = text.match(/#([A-Z][A-Z0-9.-]{0,9})\b/)
  if (hashMatch?.[1]) return hashMatch[1]
  const titleMatch = entry.title.match(/:\s*([A-Z][A-Z0-9.-]{0,9})\b/)
  if (titleMatch?.[1]) return titleMatch[1]
  const topPickMatch = entry.body.match(/\b([A-Z][A-Z0-9.-]{0,9})\s+(?:BUY|WATCH|HOLD|REJECT|SELL)\b/)
  if (topPickMatch?.[1]) return topPickMatch[1]
  return 'MARKET'
}

function inferNotificationAction(entry: QuantNotificationEntry): string {
  const metadataSide = metadataString(entry.metadata, 'side') || metadataString(entry.metadata, 'action')
  if (metadataSide) return metadataSide.toUpperCase()
  if (entry.kind === 'risk_guard') return 'WATCH / BLOCKED'
  if (entry.kind === 'weekly_summary') return 'WEEKLY REVIEW'
  if (entry.kind === 'premarket_brief') return 'PREMARKET'
  if (entry.kind === 'afterclose_brief') return 'AFTERCLOSE'
  const text = `${entry.title}\n${entry.body}`
  const actionMatch = text.match(/\b(BUY|SELL|WATCH|HOLD|REJECT|MARK|RESET|BLOCKED)\b/i)
  return actionMatch?.[1]?.toUpperCase() || 'WATCH'
}

function inferNotificationScore(entry: QuantNotificationEntry): number | string {
  const metadataScore = metadataNumber(entry.metadata, 'score')
  if (Number.isFinite(metadataScore)) return metadataScore
  const scoreMatch = `${entry.title}\n${entry.body}`.match(/(?:Score|分數|信心指數)[:：\s]*(\d+(?:\.\d+)?)/i)
  if (scoreMatch?.[1]) return Number(scoreMatch[1])
  if (entry.severity === 'critical') return 95
  if (entry.severity === 'high') return 88
  if (entry.severity === 'medium') return 72
  return 'N/A'
}

function inferNotificationPrice(entry: QuantNotificationEntry): number | string | null {
  const executionPrice = metadataNumber(entry.metadata, 'executionPrice')
  if (Number.isFinite(executionPrice)) return executionPrice
  const marketPrice = metadataNumber(entry.metadata, 'marketPrice')
  if (Number.isFinite(marketPrice)) return marketPrice
  const text = `${entry.title}\n${entry.body}`
  const priceMatch = text.match(/(?:市場價|基準進場價|悲觀成交價|price)[:：\s$]*(\d+(?:,\d{3})*(?:\.\d+)?)/i)
  if (priceMatch?.[1]) return priceMatch[1].replace(/,/g, '')
  return null
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number {
  const value = metadata?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[$,]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.NaN
}

function cleanNotificationText(value: string): string {
  return redactSensitiveText(value)
    .replace(/━━━━━━━━━━━━━━━━━━━━/g, '')
    .replace(/[*`_]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function dispatchQuantNotification(input: {
  kind: QuantNotificationKind
  severity: QuantNotificationSeverity
  title: string
  body: string
  dedupeKey: string
  source: string
  metadata?: Record<string, unknown>
}, options: { sendTelegram?: boolean; force?: boolean } = {}): Promise<QuantNotificationDispatchResult> {
  const notification = quantNotificationPath()
  const sendTelegram = options.sendTelegram !== false
  const severity = normalizeNotificationSeverity(input.severity)
  const baseEntry: QuantNotificationEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    kind: input.kind,
    severity,
    title: redactSensitiveText(input.title).slice(0, 180),
    body: redactSensitiveText(input.body).slice(0, 3400),
    dedupeKey: redactSensitiveText(input.dedupeKey).slice(0, 220),
    source: redactSensitiveText(input.source).slice(0, 120),
    status: 'logged',
    metadata: scrubSensitiveValue(input.metadata) as Record<string, unknown> | undefined,
  }

  if (!isImportantNotification(severity) && !options.force) {
    const entry = { ...baseEntry, status: 'logged' as const, reason: 'severity_below_notification_threshold' }
    await appendQuantNotification(entry)
    return { ok: true, sent: false, skipped: true, reason: entry.reason, entry, path: notification.path, relativePath: notification.relativePath }
  }

  if (!options.force && hasSentNotification(baseEntry.dedupeKey)) {
    return { ok: true, sent: false, skipped: true, reason: 'duplicate_suppressed', path: notification.path, relativePath: notification.relativePath }
  }

  if (!sendTelegram) {
    const entry = { ...baseEntry, status: 'logged' as const, reason: 'telegram_disabled' }
    await appendQuantNotification(entry)
    return { ok: true, sent: false, skipped: true, reason: entry.reason, entry, path: notification.path, relativePath: notification.relativePath }
  }

  try {
    const telegram = await sendTelegramPremiumNotification(baseEntry)
    const entry = {
      ...baseEntry,
      status: 'sent' as const,
      telegram: { ok: true, chatId: telegram.chatId },
    }
    const saved = await appendQuantNotification(entry)
    return { ok: true, sent: true, skipped: false, entry, path: saved.path, relativePath: saved.relativePath }
  } catch (err: any) {
    const entry = {
      ...baseEntry,
      status: 'failed' as const,
      reason: errorMessage(err),
      telegram: { ok: false, error: errorMessage(err), code: err?.code || 'telegram_delivery_failed' },
    }
    const saved = await appendQuantNotification(entry)
    return { ok: false, sent: false, skipped: false, reason: entry.reason, entry, path: saved.path, relativePath: saved.relativePath }
  }
}

function notificationToTelegramResult(result: QuantNotificationDispatchResult): { ok: boolean; chatId?: string; error?: string; code?: string; skipped?: boolean; reason?: string; notificationId?: string; severity?: QuantNotificationSeverity } {
  return {
    ok: result.ok || result.skipped,
    chatId: result.entry?.telegram?.chatId,
    error: result.ok || result.skipped ? undefined : result.reason,
    code: result.ok || result.skipped ? undefined : result.entry?.telegram?.code || 'notification_failed',
    skipped: result.skipped,
    reason: result.reason || result.entry?.reason,
    notificationId: result.entry?.id,
    severity: result.entry?.severity,
  }
}

function buildBriefNotificationBody(snapshot: QuantLabSnapshot, phase: QuantLabBriefPhase, paper: PaperAccountState, mirofishRun?: Awaited<ReturnType<typeof runMiroFishPhase>>): string {
  const topTen = formatTopList(snapshot, 10)
  const guard = evaluateTradingRisk(paper, snapshot)
  return `${phaseLabel(phase)} summary

Market: SPY ${getPulseValue(snapshot, 'SPY')} | QQQ ${getPulseValue(snapshot, 'QQQ')} | VIX ${getPulseValue(snapshot, 'VIX')} | 10Y ${getPulseValue(snapshot, '10Y')} | Regime ${getPulseValue(snapshot, 'Regime')}

Hermes: ${snapshot.decision.conclusion}
Action: ${snapshot.decision.action}

Top 10:
${topTen}

Paper: Equity ${formatMoney(paperEquity(paper))}; Cash ${formatMoney(paper.cash)}; P/L ${paperReturnPct(paper).toFixed(2)}%; DD ${paperDrawdownPct(paper).toFixed(2)}%; Guard ${guard.status}: ${guard.reason}

MiroFish: ${mirofishRun ? `${mirofishRun.inference.status}/${mirofishRun.inference.confidence}; support: ${mirofishRun.inference.support[0] || 'n/a'}; oppose: ${mirofishRun.inference.oppose[0] || 'n/a'}` : 'not generated'}

Invalidation: ${snapshot.decision.invalidation}`
}

function criticalRiskChecks(risk: QuantRiskEvaluation): QuantRiskCheck[] {
  const criticalKeys = new Set(['daily-loss', 'drawdown', 'stop-loss', 'vix-spike', 'qqq-trend', 'ten-year-rise'])
  return risk.checks.filter(check => check.status === 'BLOCK' && criticalKeys.has(check.key))
}

function buildRiskNotification(snapshot: QuantLabSnapshot, paper: PaperAccountState, source: string) {
  const risk = evaluateTradingRisk(paper, snapshot)
  const critical = criticalRiskChecks(risk)
  if (!critical.length) return null

  const severity: QuantNotificationSeverity = critical.some(check => ['daily-loss', 'drawdown', 'stop-loss'].includes(check.key))
    ? 'critical'
    : 'high'
  const first = critical[0]
  return {
    kind: 'risk_guard' as const,
    severity,
    title: `Risk guard triggered: ${first.label} ${first.status}`,
    body: `${first.reason}

Current guard: ${risk.status} / ${risk.reason}
Prohibited: ${risk.prohibited.join('; ') || 'none'}
Paper: Equity ${formatMoney(paperEquity(paper))}; Daily ${paperDailyReturnPct(paper).toFixed(2)}%; DD ${paperDrawdownPct(paper).toFixed(2)}%
Data: ${snapshot.dataHealth.status || 'OK'} ${snapshot.dataHealth.quoteCoverage} ${snapshot.dataHealth.quoteSource}`,
    dedupeKey: `risk:${todayKey()}:${compactDedupePart(first.key)}:${compactDedupePart(first.reason)}`,
    source,
    metadata: { checks: critical.map(check => ({ key: check.key, label: check.label, reason: check.reason })) },
  }
}

async function dispatchRiskNotification(snapshot: QuantLabSnapshot, paper: PaperAccountState, source: string, sendTelegram = true): Promise<QuantNotificationDispatchResult | null> {
  const notification = buildRiskNotification(snapshot, paper, source)
  if (!notification) return null
  return dispatchQuantNotification(notification, { sendTelegram })
}

function buildPaperTradeExecutionNotification(event: PaperTradeExecutionEvent) {
  const isBuy = event.side === 'BUY'
  const slippageSign = isBuy ? '+' : '-'
  const pnlLine = !isBuy && Number.isFinite(event.pnl) && Number.isFinite(event.pnlPct)
    ? `\n• Realized P/L: *${formatMoney(event.pnl || 0)}* (${(event.pnlPct || 0).toFixed(2)}%)`
    : ''

  return {
    kind: 'paper_trade' as const,
    severity: 'high' as const,
    title: `Paper ${event.side} executed: ${event.ticker}`,
    body: `⚡ *Hermes 紙上交易執行成功* ⚡
━━━━━━━━━━━━━━━━━━━━
• 標的：#${event.ticker}
• 動作：*${event.side} (Paper)*
• 市場價：${formatMoney(event.marketPrice)}
• 悲觀成交價：${formatMoney(event.executionPrice)} (${slippageSign}${(event.slippageRate * 100).toFixed(2)}% 滑價)
• 股數：${event.shares.toFixed(4)}
• 金額：${formatMoney(event.grossValue)}${event.score !== undefined ? `\n• 分數：${event.score}` : ''}${event.risk ? `\n• 風險：${event.risk}` : ''}${pnlLine}
• 狀態：紙上帳戶已更新，沒有送出真實券商訂單。

來源：${event.source}
備註：${event.note}`,
    dedupeKey: `paper:${todayKey()}:${event.side}:${event.ticker}:${isoMinute()}:${event.executionPrice.toFixed(4)}`,
    source: 'paper-trading-engine',
    metadata: {
      side: event.side,
      ticker: event.ticker,
      marketPrice: event.marketPrice,
      executionPrice: event.executionPrice,
      slippageRate: event.slippageRate,
      shares: event.shares,
      grossValue: event.grossValue,
      pnl: event.pnl,
      pnlPct: event.pnlPct,
    },
  }
}

async function dispatchPaperTradeNotification(event: PaperTradeExecutionEvent, sendTelegram = true): Promise<QuantNotificationDispatchResult> {
  return dispatchQuantNotification(buildPaperTradeExecutionNotification(event), { sendTelegram, force: true })
}

async function dispatchPaperTradeNotifications(events: PaperTradeExecutionEvent[], sendTelegram = true): Promise<QuantNotificationDispatchResult[]> {
  const results: QuantNotificationDispatchResult[] = []
  for (const event of events) {
    results.push(await dispatchPaperTradeNotification(event, sendTelegram))
  }
  return results
}

function buildPaperBuyBlockedNotification(input: {
  ticker: string
  score?: number
  reason: string
  source: string
}) {
  return {
    kind: 'risk_guard' as const,
    severity: 'high' as const,
    title: `Paper BUY blocked: ${input.ticker}`,
    body: `🛡️ *Hermes 戰術風控攔截* 🛡️
━━━━━━━━━━━━━━━━━━━━
• 標的：#${input.ticker}
• 原決策：BUY${input.score !== undefined ? ` (Score: ${input.score})` : ''}
• 攔截原因：\`${input.reason}\`
• 處理：強制降級為 *WATCH*，拒絕紙上送單。
• 邊界：沒有送出真實券商訂單。`,
    dedupeKey: `risk:${todayKey()}:paper-buy-block:${input.ticker}:${compactDedupePart(input.reason)}`,
    source: input.source,
    metadata: { ticker: input.ticker, score: input.score, reason: input.reason },
  }
}

async function dispatchPaperBuyBlockedNotification(input: {
  ticker: string
  score?: number
  reason: string
  source: string
}, sendTelegram = true): Promise<QuantNotificationDispatchResult> {
  return dispatchQuantNotification(buildPaperBuyBlockedNotification(input), { sendTelegram })
}

function buildActionNotification(entry: {
  type: string
  payload?: Record<string, unknown>
  source?: string
  status?: string
}) {
  const payload = entry.payload || {}
  const requestedSeverity = normalizeNotificationSeverity(payload.severity || payload.importance)
  const notifyRequested = payload.notify === true || isImportantNotification(requestedSeverity)
  const ticker = typeof payload.ticker === 'string' ? payload.ticker.toUpperCase() : ''

  if (entry.type === 'SET_ALERT') {
    const condition = typeof payload.condition === 'string' ? payload.condition : typeof payload.note === 'string' ? payload.note : 'AI alert condition'
    const severity = isImportantNotification(requestedSeverity) ? requestedSeverity : 'high'
    return {
      kind: 'terminal_action' as const,
      severity,
      title: `AI alert set${ticker ? `: ${ticker}` : ''}`,
      body: `${condition}

This alert was created by an audited AI action. It is informational and paper-mode only.`,
      dedupeKey: `action:${todayKey()}:set-alert:${ticker || 'market'}:${compactDedupePart(condition)}`,
      source: entry.source || 'action-audit',
      metadata: { type: entry.type, payload },
    }
  }

  if (entry.type === 'SIMULATE_TRADE' && notifyRequested) {
    const action = typeof payload.action === 'string' ? payload.action.toUpperCase() : 'SIMULATE'
    return {
      kind: 'terminal_action' as const,
      severity: requestedSeverity,
      title: `High-importance paper simulation${ticker ? `: ${ticker}` : ''}`,
      body: `${action} simulation requested.

Reason: ${typeof payload.reason === 'string' ? payload.reason : typeof payload.note === 'string' ? payload.note : 'No reason supplied.'}

This is not a real order.`,
      dedupeKey: `action:${todayKey()}:simulate:${ticker || 'market'}:${compactDedupePart(action)}`,
      source: entry.source || 'action-audit',
      metadata: { type: entry.type, payload },
    }
  }

  return null
}

async function dispatchActionNotification(entry: {
  type: string
  payload?: Record<string, unknown>
  source?: string
  status?: string
}): Promise<QuantNotificationDispatchResult | null> {
  if (entry.status === 'rejected') return null
  const notification = buildActionNotification(entry)
  if (!notification) return null
  return dispatchQuantNotification(notification, { sendTelegram: true })
}

async function appendActionAudit(body: {
  type?: string
  payload?: Record<string, unknown>
  raw?: string
  source?: string
  messageId?: string
  status?: 'accepted' | 'rejected'
  reason?: string
}) {
  const audit = actionAuditPath()
  const targetDir = resolve(audit.path, '..')
  if (!audit.path.startsWith(targetDir)) {
    const err = new Error('Invalid action audit path') as Error & { code?: string }
    err.code = 'invalid_path'
    throw err
  }

  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    type: isTerminalActionType(body.type) ? body.type : String(body.type || 'INVALID'),
    payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (scrubSensitiveValue(body.payload) as Record<string, unknown>)
      : {},
    raw: typeof body.raw === 'string' ? redactSensitiveText(body.raw).slice(0, 5000) : undefined,
    source: typeof body.source === 'string' ? redactSensitiveText(body.source).slice(0, 80) : 'unknown',
    messageId: typeof body.messageId === 'string' ? redactSensitiveText(body.messageId).slice(0, 120) : undefined,
    status: body.status === 'rejected' ? 'rejected' : 'accepted',
    reason: typeof body.reason === 'string' ? redactSensitiveText(body.reason).slice(0, 500) : undefined,
  }

  await mkdir(targetDir, { recursive: true })
  await appendFile(audit.path, `${JSON.stringify(entry)}\n`, 'utf-8')

  return {
    entry,
    path: audit.path,
    relativePath: audit.relativePath,
  }
}

async function sendTelegramPremiumNotification(entry: QuantNotificationEntry) {
  const { token, chatId } = resolveTelegramTarget()
  const result = await TelegramNotifier.sendPremiumQuantAlert(buildPremiumQuantTelegramAlert(entry), {
    token,
    chatId,
    disableWebPagePreview: true,
    timeoutMs: 10_000,
  })

  if (result.ok) return { chatId: result.chatId || chatId || undefined }

  if (result.code === 'telegram_not_configured' || result.skipped) {
    const err = new Error('Telegram is not configured for Quant Lab delivery') as Error & { code?: string }
    err.code = 'telegram_not_configured'
    throw err
  }

  const err = new Error(result.error || `Telegram delivery failed: HTTP ${result.statusCode || 'unknown'}`) as Error & { code?: string }
  err.code = result.code || 'telegram_delivery_failed'
  throw err
}

function firstListValue(value: string | null): string | null {
  if (!value) return null
  return value.split(',').map(item => item.trim()).find(Boolean) || null
}

function resolveTelegramTarget(): { token: string | null; chatId: string | null } {
  const token = getProfileEnvValue('TELEGRAM_BOT_TOKEN')
  const chatId =
    getProfileEnvValue('TELEGRAM_HOME_CHANNEL') ||
    getProfileEnvValue('TELEGRAM_HOME_CHAT_ID') ||
    getProfileEnvValue('TELEGRAM_CHAT_ID') ||
    firstListValue(getProfileEnvValue('TELEGRAM_ALLOWED_CHAT_IDS')) ||
    firstListValue(getProfileEnvValue('KK_TELEGRAM_ALLOWED_CHAT_IDS')) ||
    firstListValue(getProfileEnvValue('TELEGRAM_ALLOWED_USERS'))

  return { token, chatId }
}

quantLabRoutes.get('/api/hermes/quant-lab/phase-validation', async (ctx) => {
  try {
    ctx.body = await validateQuantLabPhases({ ensure: ctx.query.ensure === '1' || ctx.query.ensure === 'true' })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { ok: false, error: errorMessage(err), code: err?.code || 'phase_validation_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/phase-validation', async (ctx) => {
  const body = ctx.request.body as { ensure?: boolean } | undefined
  try {
    ctx.body = await validateQuantLabPhases({ ensure: body?.ensure !== false })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { ok: false, error: errorMessage(err), code: err?.code || 'phase_validation_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/snapshot', async (ctx) => {
  const forceRefresh = ctx.query.fresh === '1' || ctx.query.cache === 'bypass'
  const { snapshot, cachedAt, cacheStatus } = await getCachedQuantLabSnapshot(forceRefresh)
  ctx.set('X-Aurora-Quant-Snapshot-Cache', cacheStatus)
  ctx.set('X-Aurora-Quant-Snapshot-Cached-At', new Date(cachedAt).toISOString())
  ctx.body = snapshot
})

quantLabRoutes.get('/api/hermes/quant-lab/provider-settings', async (ctx) => {
  try {
    ctx.body = buildProviderSettings()
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'provider_settings_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/provider-settings', async (ctx) => {
  try {
    ctx.body = await updateProviderSettings(ctx.request.body)
  } catch (err: any) {
    ctx.status = 400
    ctx.body = { error: errorMessage(err), code: err?.code || 'provider_settings_update_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/provider-test', async (ctx) => {
  try {
    const body = ctx.request.body as { symbol?: string; timeframe?: string }
    ctx.body = await testProviderFeeds(body?.symbol, body?.timeframe)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'provider_test_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/candles', async (ctx) => {
  try {
    ctx.body = await buildCandleResponse(ctx.query.symbol, ctx.query.timeframe, ctx.query.limit)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'candles_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/paper-account', async (ctx) => {
  try {
    const snapshot = await buildQuantLabSnapshot()
    const paper = readPaperAccount()
    const mark = markPaperToMarket(paper, snapshot)
    ensurePaperRiskState(paper)
    paper.updatedAt = new Date().toISOString()
    await writePaperAccount(paper)
    const report = await savePaperDailyReport(
      snapshot,
      paper,
      `auto mark-to-market; updated ${mark.updated.length} position(s); missing ${mark.missing.join(', ') || 'none'}`
    )
    ctx.body = { ...paperAccountResponse(paper, snapshot), report }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'paper_account_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/paper-trades', async (ctx) => {
  try {
    const snapshot = await buildQuantLabSnapshot()
    const paper = readPaperAccount()
    markPaperToMarket(paper, snapshot)
    ensurePaperRiskState(paper)
    const trades = paperTradeHistory(paper)
    const equityCurve = buildPaperEquityCurve(paper, trades)
    ctx.body = {
      ok: true,
      generatedAt: new Date().toISOString(),
      source: snapshot.source,
      account: {
        equity: Number(paperEquity(paper).toFixed(2)),
        initialCapital: paper.initialCapital,
        returnPct: Number(paperReturnPct(paper).toFixed(2)),
        winRate: Number(paperWinRate(paper).toFixed(2)),
        profitFactor: Number.isFinite(paperProfitFactor(paper)) ? Number(paperProfitFactor(paper).toFixed(2)) : null,
        maxDrawdownPct: Number(paperDrawdownPct(paper).toFixed(2)),
        realizedPnl: Number(paper.realizedPnl.toFixed(2)),
        tradeCount: paper.tradeCount,
        wins: paper.wins,
        losses: paper.losses,
      },
      trades,
      equityCurve,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'paper_trades_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/post-mortems', async (ctx) => {
  try {
    const limit = clamp(Number(ctx.query.limit || 50), 1, 200)
    const root = resolveKnowledgeRoot()
    const entries = await listPostMortemReports({ knowledgeRoot: root })
    const postMortemPath = resolve(root, 'trading-journal', 'post-mortems')

    ctx.body = {
      ok: true,
      path: postMortemPath,
      entries: entries.slice(0, limit),
      count: entries.length,
      updatedAt: new Date().toISOString(),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'post_mortems_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/action-audit', async (ctx) => {
  const limit = clamp(Number(ctx.query.limit || 80), 1, 500)
  const audit = actionAuditPath()
  if (!existsSync(audit.path)) {
    ctx.body = { ok: true, entries: [], path: audit.path, relativePath: audit.relativePath }
    return
  }

  const entries = readFileSync(audit.path, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map(line => {
      try {
        return scrubSensitiveValue(JSON.parse(line))
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .reverse()

  ctx.body = { ok: true, entries, path: audit.path, relativePath: audit.relativePath }
})

quantLabRoutes.post('/api/hermes/quant-lab/action-audit', async (ctx) => {
  const body = ctx.request.body as {
    type?: string
    payload?: Record<string, unknown>
    raw?: string
    source?: string
    messageId?: string
    status?: 'accepted' | 'rejected'
    reason?: string
  } | undefined

  try {
    const saved = await appendActionAudit(body || {})
    const notification = await dispatchActionNotification(saved.entry)
    ctx.body = { ok: true, ...saved, notification }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'action_audit_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/paper-account/action', async (ctx) => {
  const body = ctx.request.body as { action?: PaperAccountAction; ticker?: string; journalAction?: PaperJournalAction; note?: string } | undefined
  const action = body?.action
  const ticker = (body?.ticker || '').trim().toUpperCase()

  if (!action || !['BUY', 'SELL', 'MARK', 'RESET', 'JOURNAL'].includes(action)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid paper account action', code: 'invalid_action' }
    return
  }

  try {
    let paper = action === 'RESET' ? createPaperAccount() : readPaperAccount()
    let snapshot: QuantLabSnapshot | null = null
    let tradeNotification: QuantNotificationDispatchResult | null = null
    let blockedNotification: QuantNotificationDispatchResult | null = null

    if (action === 'RESET') {
      addPaperJournal(paper, 'SYSTEM', 'RESET', '$1000 paper account reset by user. No real brokerage orders are placed.')
    } else {
      snapshot = await buildQuantLabSnapshot()
      const mark = markPaperToMarket(paper, snapshot)

      if (action === 'MARK') {
        addPaperJournal(
          paper,
          'SYSTEM',
          'MARK',
          `Marked paper positions to ${snapshot.source}. Updated ${mark.updated.length}; missing ${mark.missing.join(', ') || 'none'}.`
        )
      }

      if (action === 'JOURNAL') {
        const journalAction = body?.journalAction && ['BUY', 'SELL', 'HOLD', 'WATCH', 'MARK', 'RESET'].includes(body.journalAction)
          ? body.journalAction
          : 'WATCH'
        const note = (body?.note || '').trim().slice(0, 800)
        if (!note) {
          ctx.status = 400
          ctx.body = { error: 'Missing journal note', code: 'missing_note' }
          return
        }
        addPaperJournal(paper, ticker || 'AI', journalAction, note)
      }

      if (action === 'BUY') {
        const pick = snapshot.topPicks.find(item => item.ticker === ticker)
        if (!pick) {
          ctx.status = 404
          ctx.body = { error: `Ticker ${ticker || '(blank)'} is not in today's Top 10`, code: 'ticker_not_found' }
          return
        }
        const bought = buyPaperPick(paper, pick, snapshot)
        if (bought) {
          tradeNotification = await dispatchPaperTradeNotification(bought, true)
        } else {
          const reason = paper.riskState.lastGuardrail || 'Paper buy skipped by paper account guardrails.'
          if (!paper.riskState.lastGuardrail) addPaperJournal(paper, pick.ticker, 'WATCH', reason)
          blockedNotification = await dispatchPaperBuyBlockedNotification({
            ticker: pick.ticker,
            score: pick.score,
            reason,
            source: `paper-action:${action}`,
          }, true)
        }
      }

      if (action === 'SELL') {
        if (!ticker) {
          ctx.status = 400
          ctx.body = { error: 'Missing ticker for paper sell', code: 'missing_ticker' }
          return
        }
        const sold = sellPaperPosition(paper, ticker, 'User-triggered paper sell.', `snapshot ${snapshot.source}; quote ${snapshot.dataHealth.quoteSource}`)
        if (sold) tradeNotification = await dispatchPaperTradeNotification(sold, true)
        if (!sold) addPaperJournal(paper, ticker, 'WATCH', 'No open paper position to sell.')
      }
    }

    paper.maxEquity = Math.max(paper.maxEquity, paperEquity(paper))
    ensurePaperRiskState(paper)
    paper.updatedAt = new Date().toISOString()
    await writePaperAccount(paper)
    const reportSnapshot = snapshot || await buildQuantLabSnapshot()
    const report = await savePaperDailyReport(reportSnapshot, paper, `paper action ${action}${ticker ? ` ${ticker}` : ''}`)
    const notification = await dispatchRiskNotification(reportSnapshot, paper, `paper-action:${action}`, true)
    ctx.body = { ...paperAccountResponse(paper, reportSnapshot), report, notification, tradeNotification, blockedNotification }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'paper_action_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/run-brief', async (ctx) => {
  const body = ctx.request.body as {
    phase?: QuantLabBriefPhase
    saveReport?: boolean
    sendTelegram?: boolean
    forceTelegram?: boolean
    submitMiroFish?: boolean
  } | undefined
  const phase: QuantLabBriefPhase = body?.phase === 'afterclose' ? 'afterclose' : 'premarket'
  const shouldSaveReport = body?.saveReport !== false
  const shouldSendTelegram = body?.sendTelegram !== false
  const shouldForceTelegram = body?.forceTelegram === true
  const shouldSubmitMiroFish = body?.submitMiroFish === true

  try {
    const snapshot = await buildQuantLabSnapshot()
    const paperTradeEvents: PaperTradeExecutionEvent[] = []
    const paper = applyPaperStrategy(readPaperAccount(), snapshot, phase, paperTradeEvents)
    const mirofishRun = await runMiroFishPhase(snapshot, phase, paper, shouldSubmitMiroFish)
    const evidenceArchive = await persistMiroFishEvidenceJournal(snapshot, phase, paper, mirofishRun)
    await writePaperAccount(paper)
    const paperReport = await savePaperDailyReport(snapshot, paper, `${phase} brief auto-update; MiroFish evidence ${evidenceArchive.relativePath}`)
    const markdown = buildBriefMarkdown(snapshot, phase, paper, mirofishRun, evidenceArchive)
    const fileName = `${todayKey()}-quant-lab-${phase}.md`
    let saved: { path: string; relativePath: string } | null = null
    let telegram: { ok: boolean; chatId?: string; error?: string; code?: string; skipped?: boolean; reason?: string; notificationId?: string; severity?: QuantNotificationSeverity } | null = null
    let riskNotification: QuantNotificationDispatchResult | null = null
    let tradeNotifications: QuantNotificationDispatchResult[] = []
    let synthesisBlockNotification: QuantNotificationDispatchResult | null = null

    if (shouldSaveReport) {
      saved = await saveMarkdownToJournal(markdown, fileName)
    }

    if (shouldSendTelegram) {
      const notification = await dispatchQuantNotification({
        kind: phase === 'afterclose' ? 'afterclose_brief' : 'premarket_brief',
        severity: 'high',
        title: `Hermes Quant Lab ${phaseLabel(phase)}簡報 ${todayKey()}`,
        body: buildBriefNotificationBody(snapshot, phase, paper, mirofishRun),
        dedupeKey: `brief:${todayKey()}:${phase}`,
        source: 'run-brief',
        metadata: {
          phase,
          source: snapshot.source,
          report: saved?.relativePath,
          mirofish: mirofishRun.inference.reportRelativePath,
          evidenceArchive: evidenceArchive.relativePath,
        },
      }, { sendTelegram: true, force: shouldForceTelegram })
      telegram = notificationToTelegramResult(notification)
    }
    const maybeRiskNotification = await dispatchRiskNotification(snapshot, paper, `run-brief:${phase}`, shouldSendTelegram)
    riskNotification = maybeRiskNotification || null
    const decisionForBlock = snapshot.decision as typeof snapshot.decision & {
      quantScore?: number | null
      portfolioExposure?: { allowed?: boolean; reason?: string } | null
    }
    if (decisionForBlock.portfolioExposure && decisionForBlock.portfolioExposure.allowed === false) {
      synthesisBlockNotification = await dispatchPaperBuyBlockedNotification({
        ticker: snapshot.topPicks[0]?.ticker || 'AI',
        score: typeof decisionForBlock.quantScore === 'number' ? decisionForBlock.quantScore : undefined,
        reason: decisionForBlock.portfolioExposure.reason || 'Portfolio exposure guard blocked Phase 5 BUY.',
        source: `hermes-synthesizer:${phase}`,
      }, shouldSendTelegram)
    }
    tradeNotifications = await dispatchPaperTradeNotifications(paperTradeEvents, shouldSendTelegram)

    ctx.body = {
      ok: true,
      phase,
      source: snapshot.source,
      generatedAt: snapshot.generatedAt,
      saved,
      telegram,
      notification: riskNotification,
      tradeNotifications,
      synthesisBlockNotification,
      mirofish: {
        status: mirofishRun.inference.status,
        seed: {
          path: mirofishRun.seed.path,
          relativePath: mirofishRun.seed.relativePath,
        },
        requirement: mirofishRun.seed.requirement,
        inference: mirofishRun.inference,
        evidenceArchive,
      },
      topPicks: snapshot.topPicks.slice(0, 10),
      paper: {
        equity: Number(paperEquity(paper).toFixed(2)),
        cash: Number(paper.cash.toFixed(2)),
        returnPct: Number(paperReturnPct(paper).toFixed(2)),
        dailyReturnPct: Number(paperDailyReturnPct(paper).toFixed(2)),
        maxDrawdownPct: Number(paperDrawdownPct(paper).toFixed(2)),
        positions: paper.positions.length,
        statePath: paperStatePath(),
        report: paperReport,
      },
      summary: {
        title: `Hermes Quant Lab ${phaseLabel(phase)}簡報 ${todayKey()}`,
        conclusion: snapshot.decision.conclusion,
        action: snapshot.decision.action,
        invalidation: snapshot.decision.invalidation,
      },
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'brief_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/run-weekly-summary', async (ctx) => {
  const body = ctx.request.body as {
    saveReport?: boolean
    sendTelegram?: boolean
    forceTelegram?: boolean
  } | undefined
  const shouldSaveReport = body?.saveReport !== false
  const shouldSendTelegram = body?.sendTelegram !== false
  const shouldForceTelegram = body?.forceTelegram === true

  try {
    const snapshot = await buildQuantLabSnapshot()
    const paper = readPaperAccount()
    markPaperToMarket(paper, snapshot)
    ensurePaperRiskState(paper)
    paper.updatedAt = new Date().toISOString()
    await writePaperAccount(paper)
    const sources = await listWeeklyBriefSources(12)
    const markdown = buildWeeklySummaryMarkdown(snapshot, paper, sources)
    let saved: { path: string; relativePath: string } | null = null
    let telegram: { ok: boolean; chatId?: string; error?: string; code?: string; skipped?: boolean; reason?: string; notificationId?: string; severity?: QuantNotificationSeverity } | null = null

    if (shouldSaveReport) {
      saved = await saveMarkdownToJournal(markdown, `${todayKey()}-quant-lab-weekly-summary.md`)
    }

    if (shouldSendTelegram) {
      const notification = await dispatchQuantNotification({
        kind: 'weekly_summary',
        severity: 'high',
        title: `Hermes Quant Lab 每週總結 ${todayKey()}`,
        body: buildWeeklySummaryTelegramText(snapshot, paper, sources),
        dedupeKey: `weekly-summary:${todayKey()}`,
        source: 'run-weekly-summary',
        metadata: {
          source: snapshot.source,
          report: saved?.relativePath,
          sourceBriefs: sources.map(source => source.relativePath),
          universeSize: snapshot.dataHealth.universeSize,
        },
      }, { sendTelegram: true, force: shouldForceTelegram })
      telegram = notificationToTelegramResult(notification)
    }

    ctx.body = {
      ok: true,
      source: snapshot.source,
      generatedAt: snapshot.generatedAt,
      saved,
      telegram,
      sourceBriefs: sources,
      topPicks: snapshot.topPicks.slice(0, 10),
      summary: {
        title: `Hermes Quant Lab 每週總結 ${todayKey()}`,
        conclusion: snapshot.decision.conclusion,
        action: snapshot.decision.action,
        invalidation: snapshot.decision.invalidation,
      },
      paper: {
        equity: Number(paperEquity(paper).toFixed(2)),
        cash: Number(paper.cash.toFixed(2)),
        returnPct: Number(paperReturnPct(paper).toFixed(2)),
        dailyReturnPct: Number(paperDailyReturnPct(paper).toFixed(2)),
        maxDrawdownPct: Number(paperDrawdownPct(paper).toFixed(2)),
        positions: paper.positions.length,
        statePath: paperStatePath(),
      },
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'weekly_summary_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/run-mirofish', async (ctx) => {
  const body = ctx.request.body as {
    phase?: QuantLabBriefPhase
    submitBackend?: boolean
    targetTicker?: string
    topic?: string
  } | undefined
  const phase: QuantLabBriefPhase = body?.phase === 'afterclose' ? 'afterclose' : 'premarket'
  const submitBackend = body?.submitBackend !== false
  const targetTicker = normalizeMiroFishTargetTicker(body?.targetTicker)
  const topic = normalizeMiroFishTopic(body?.topic)
  const universalTopic = isUniversalMiroFishTopic(topic, targetTicker)

  try {
    const snapshot = await buildQuantLabSnapshot()
    const focusedSnapshot = focusSnapshotOnTargetTicker(snapshot, targetTicker)
    const paper = readPaperAccount()
    const mirofishRun = await runMiroFishPhase(focusedSnapshot, phase, paper, submitBackend, universalTopic ? topic : '')
    const evidenceArchive = await persistMiroFishEvidenceJournal(focusedSnapshot, phase, paper, mirofishRun)
    const memoryRecord = await saveMiroFishLongTermMemory({
      snapshot: focusedSnapshot,
      phase,
      paper,
      mirofishRun,
      evidenceArchive,
      topic,
    })
    await writePaperAccount(paper)

    ctx.body = {
      ok: true,
      phase,
      source: focusedSnapshot.source,
      generatedAt: focusedSnapshot.generatedAt,
      mirofish: {
        status: mirofishRun.inference.status,
        seed: {
          path: mirofishRun.seed.path,
          relativePath: mirofishRun.seed.relativePath,
        },
        requirement: mirofishRun.seed.requirement,
        inference: mirofishRun.inference,
        evidenceArchive,
        memoryRecord,
      },
      evidenceCount: mirofishRun.evidence.length,
      topPicks: universalTopic
        ? [buildSyntheticTopicTopPick(topic)]
        : focusedSnapshot.topPicks.slice(0, 10),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: miroFishSafeErrorMessage(err), code: err?.code || 'mirofish_run_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/mirofish-task-status', async (ctx) => {
  try {
    ctx.body = await getMiroFishGraphTaskStatus(
      textQueryValue(ctx.query.taskId),
      textQueryValue(ctx.query.projectId)
    )
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { ok: false, error: miroFishSafeErrorMessage(err), code: err?.code || 'mirofish_task_status_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/mirofish-graph-summary', async (ctx) => {
  try {
    ctx.body = await getMiroFishGraphSummary(textQueryValue(ctx.query.graphId))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { ok: false, error: miroFishSafeErrorMessage(err), code: err?.code || 'mirofish_graph_summary_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/mirofish-evidence-archives', async (ctx) => {
  try {
    ctx.body = await listMiroFishEvidenceArchives(Number(ctx.query.limit || 24))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { ok: false, error: miroFishSafeErrorMessage(err), code: err?.code || 'mirofish_evidence_archives_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/mirofish-memory-records', async (ctx) => {
  try {
    ctx.body = await listMiroFishMemoryRecords(Number(ctx.query.limit || 80))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { ok: false, error: miroFishSafeErrorMessage(err), code: err?.code || 'mirofish_memory_records_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/notifications', async (ctx) => {
  const limit = clamp(Number(ctx.query.limit || 80), 1, 500)
  const notification = quantNotificationPath()
  ctx.body = {
    ok: true,
    entries: readQuantNotificationEntries(limit),
    path: notification.path,
    relativePath: notification.relativePath,
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/notifications/evaluate', async (ctx) => {
  const body = ctx.request.body as {
    sendTelegram?: boolean
    source?: string
  } | undefined

  try {
    const snapshot = await buildQuantLabSnapshot()
    const paper = readPaperAccount()
    const notification = await dispatchRiskNotification(
      snapshot,
      paper,
      body?.source || 'manual-risk-evaluate',
      body?.sendTelegram !== false
    )
    ctx.body = {
      ok: true,
      source: snapshot.source,
      generatedAt: snapshot.generatedAt,
      notification,
      guardrails: paperAccountResponse(paper, snapshot).guardrails,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'notification_evaluate_failed' }
  }
})

quantLabRoutes.get('/api/hermes/quant-lab/audit-snapshots', async (ctx) => {
  const limit = clamp(Number(ctx.query.limit || 12), 1, 50)
  try {
    const result = await listMiroFishAuditSnapshots(limit)
    ctx.body = { ok: true, ...result, updatedAt: new Date().toISOString() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'audit_snapshots_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/save-report', async (ctx) => {
  const body = ctx.request.body as { content?: string; fileName?: string } | undefined
  const content = body?.content || ''

  if (!content.trim()) {
    ctx.status = 400
    ctx.body = { error: 'Missing report content', code: 'missing_content' }
    return
  }

  try {
    const saved = await saveReportToJournal(redactSensitiveText(content), body?.fileName)
    ctx.body = { ok: true, ...saved }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: errorMessage(err), code: err?.code || 'save_failed' }
  }
})

quantLabRoutes.post('/api/hermes/quant-lab/send-telegram', async (ctx) => {
  const body = ctx.request.body as { text?: string } | undefined
  const text = redactSensitiveText((body?.text || '').trim())

  if (!text) {
    ctx.status = 400
    ctx.body = { error: 'Missing Telegram message text', code: 'missing_text' }
    return
  }

  try {
    const result = await dispatchQuantNotification({
      kind: 'paper_trade',
      severity: 'high',
      title: `Manual Quant Lab Telegram ${todayKey()}`,
      body: text,
      dedupeKey: `manual-telegram:${todayKey()}:${compactDedupePart(text.slice(0, 180))}`,
      source: 'manual-telegram',
    }, { sendTelegram: true })
    const telegram = notificationToTelegramResult(result)
    ctx.status = telegram.ok ? 200 : 502
    ctx.body = telegram.ok
      ? { ok: true, chatId: telegram.chatId, skipped: telegram.skipped, reason: telegram.reason, notificationId: telegram.notificationId, severity: telegram.severity }
      : { ok: false, error: telegram.error || result.reason || 'Telegram delivery failed', code: telegram.code || 'telegram_delivery_failed' }
  } catch (err: any) {
    ctx.status = err?.code === 'telegram_not_configured' ? 400 : 502
    ctx.body = {
      error: errorMessage(err),
      code: err?.code || 'telegram_delivery_failed',
    }
  }
})
