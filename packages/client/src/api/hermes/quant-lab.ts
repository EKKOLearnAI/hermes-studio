import { request } from '../client'

export type QuantLabTone = 'up' | 'down' | 'warn' | 'neutral'
export type QuantLabAction = 'BUY' | 'HOLD' | 'WATCH'
export type QuantLabRisk = 'L' | 'M' | 'H'
export type QuantLabTruthMode = 'real' | 'partial' | 'fallback' | 'mock'
export type QuantLabTerminalActionType = 'DRAW_LINE' | 'CHANGE_TICKER' | 'SIMULATE_TRADE' | 'ADD_JOURNAL' | 'SET_ALERT'
export type QuantLabNotificationSeverity = 'low' | 'medium' | 'high' | 'critical'
export type QuantLabNotificationKind = 'premarket_brief' | 'afterclose_brief' | 'weekly_summary' | 'risk_guard' | 'terminal_action' | 'paper_trade' | 'data_health' | 'mirofish'

export interface QuantLabMarketPulseItem {
  label: string
  value: string
  tone: QuantLabTone
}

export interface QuantLabTopPick {
  ticker: string
  score: number
  action: QuantLabAction
  trend: string
  risk: QuantLabRisk
  reason: string
  price: number
  scoreBreakdown?: {
    quality: number
    momentum: number
    earnings?: number
    liquidity?: number
    regime: number
    risk: number
    final: number
    rawFinal?: number
    confidence: 'high' | 'medium' | 'low'
    source: string
    sector?: string
    theme?: string
    valuation?: {
      adjustedScore: number
      originalScore: number | null
      delta: string
      label: string
      riskTier?: string
      scoreCap?: number | null
      maxAction?: QuantLabAction
      warning?: string
      rank: number | null
      fundamentalValueScore: number | null
      valueProxy: number | null
      evFcf: string
      baseGap: string
      applicable: boolean
      report: string
      sourceDate: string
    }
    notes: string[]
  }
}

export interface QuantLabDecision {
  conclusion: string
  action: string
  invalidation: string
  expectedScore?: number | null
  quantScore?: number | null
  mirofishScore?: number | null
  macroRisk?: number | null
  vix?: number | null
  riskMultiplier?: number | null
  macroRegime?: string | null
  macroInsight?: string | null
  weights?: {
    w1: number
    w2: number
    w3: number
  } | null
  weightRegime?: 'risk-on' | 'neutral-chop' | 'risk-off' | null
  weightRegimeLabel?: string | null
  synthesisAction?: 'BUY' | 'WATCH' | 'REJECT' | 'SELL'
  terminalMessage?: string
  actionPayload?: {
    type: 'SIMULATE_TRADE'
    action: 'BUY'
    side: 'BUY'
    ticker: string
    qty: number
  } | null
  portfolioExposure?: {
    allowed: boolean
    sector: string
    sectorPositionCount: number
    sectorValue: number
    sectorWeight: number
    reason: string
  } | null
  synthesisReasons?: string[]
  synthesisFormula?: string
}

export interface QuantLabBacktest {
  strategy: string
  cagr: string
  sharpe: string
  maxDd: string
  win: string
  status: string
}

export interface QuantLabPriceBookItem {
  ticker: string
  price: number
  trend: string
  source: string
  quoteSource: string
  updatedAt: string
}

export type QuantLabCandleTimeframe = '5m' | '15m' | '1h' | '1d'

export interface QuantLabCandleBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface QuantLabDailySignal {
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

export interface QuantLabProviderStatus {
  provider: string
  configured: boolean
  status: 'ready' | 'missing-key' | 'ok' | 'partial' | 'failed' | 'skipped'
  detail: string
}

export interface QuantLabDataTruthItem {
  area: string
  mode: QuantLabTruthMode
  source: string
  detail: string
}

export interface QuantLabDataHealth {
  status?: 'OK' | 'DEGRADED' | 'FALLBACK' | 'ERROR'
  quoteSource: string
  quoteProvider?: string
  quoteCoverage: string
  quoteLatencyMs?: number
  missingSymbols: string[]
  staleSymbols?: string[]
  fallbackSymbols?: string[]
  fallbackUsed?: boolean
  delayed?: boolean
  providerChain?: string[]
  providerErrors?: string[]
  providerStatus?: QuantLabProviderStatus[]
  dataTruth?: QuantLabDataTruthItem[]
  universeSize?: number
  stockUniverseSize?: number
  receivedSymbols?: string[]
  backtestSource: string
  updatedAt: string
}

export interface QuantLabWfRollingPerformance {
  date: string
  generatedAt: string
  policy: string
  snapshotCount: number
  avgReturn5d: number | null
  winRate5d: number | null
  sampleCount5d: number
  spyAvgReturn5d?: number | null
  avgAlphaVsSpy5d?: number | null
  outperformSpyRate5d?: number | null
  outperformSpySampleCount5d?: number
  avgReturn10d: number | null
  winRate10d: number | null
  sampleCount10d: number
  spyAvgReturn10d?: number | null
  avgAlphaVsSpy10d?: number | null
  outperformSpyRate10d?: number | null
  outperformSpySampleCount10d?: number
  avgReturn20d: number | null
  winRate20d: number | null
  sampleCount20d: number
  spyAvgReturn20d?: number | null
  avgAlphaVsSpy20d?: number | null
  outperformSpyRate20d?: number | null
  outperformSpySampleCount20d?: number
  dailySampleCount: number
  dailyAvgReturn: number | null
  dailyWinRate: number | null
  dailyVol: number | null
  dailySharpeProxy: number | null
  dailyAvgAlphaVsSpy?: number | null
  dailyOutperformSpyRate?: number | null
  dailyOutperformSpySampleCount?: number
  avgTurnover: number | null
  latestTurnover: number | null
  latestAdded: string[]
  latestRemoved: string[]
  latestKept: string[]
  sourceFile: string
  sourceDate: string
}

export interface QuantLabSnapshot {
  generatedAt: string
  source: string
  marketPulse: QuantLabMarketPulseItem[]
  topPicks: QuantLabTopPick[]
  riskRules: string[]
  decision: QuantLabDecision
  chartCaption: string[]
  graphCaption: string[]
  backtests: QuantLabBacktest[]
  backtestSummary: string[]
  priceBook?: QuantLabPriceBookItem[]
  dailySignals?: QuantLabDailySignal[]
  dataHealth: QuantLabDataHealth
  mirofishSeed?: QuantLabMiroFishSeed | null
  mirofishInference?: QuantLabMiroFishInference | null
  wfRollingPerformance?: QuantLabWfRollingPerformance | null
}

export type QuantLabPhaseValidationStatus = 'PASS' | 'FAIL'
export type QuantLabPhaseKey = 'phase-1-data' | 'phase-2-selection' | 'phase-3-risk' | 'phase-4-mirofish' | 'phase-5-decision' | 'phase-6-paper' | 'phase-7-memory' | 'phase-8-openclaw' | 'phase-9-telegram' | 'phase-10-agent-eval'

export interface QuantLabPhaseValidationCheck {
  key: string
  label: string
  status: QuantLabPhaseValidationStatus
  detail: string
  metadata?: Record<string, unknown>
}

export interface QuantLabPhaseValidationResult {
  phase: number
  key: QuantLabPhaseKey
  title: string
  status: QuantLabPhaseValidationStatus
  checks: QuantLabPhaseValidationCheck[]
}

export interface QuantLabPhaseValidationReport {
  ok: boolean
  generatedAt: string
  source: string
  quoteCoverage: string
  universeSize: number
  stockUniverseSize?: number
  firstFailedPhase: {
    phase: number
    key: QuantLabPhaseKey
    title: string
  } | null
  phases: QuantLabPhaseValidationResult[]
}

export interface QuantLabCandlesResult {
  ok: boolean
  symbol: string
  timeframe: QuantLabCandleTimeframe
  source: string
  status: 'OK' | 'DEGRADED' | 'FALLBACK' | 'ERROR'
  mode: QuantLabTruthMode
  bars: QuantLabCandleBar[]
  updatedAt: string
  providerStatus: QuantLabProviderStatus[]
  providerErrors: string[]
  message?: string
  dataTruth: QuantLabDataTruthItem
}

export interface QuantLabProviderSecretField {
  key: string
  configured: boolean
  mask: string
  aliases: string[]
}

export interface QuantLabProviderSetting {
  provider: string
  configured: boolean
  status: 'ready' | 'missing-key' | 'ok' | 'partial' | 'failed' | 'skipped'
  purpose: string
  detail?: string
  fields: QuantLabProviderSecretField[]
}

export interface QuantLabProviderSettings {
  ok: boolean
  envPath: string
  updatedAt: string
  providers: QuantLabProviderSetting[]
}

export interface SaveQuantLabProviderSettingsPayload {
  alpacaKeyId?: string
  alpacaSecretKey?: string
  polygonApiKey?: string
  clear?: string[]
}

export interface QuantLabProviderProbe {
  status: 'missing-key' | 'ok' | 'failed' | 'skipped'
  detail: string
  latencyMs: number
  price?: number
  changePercent?: number | null
  bars?: number
  latestClose?: number
  latestTime?: number
}

export interface QuantLabProviderTestRow {
  provider: string
  configured: boolean
  quote: QuantLabProviderProbe
  candles: QuantLabProviderProbe
}

export interface QuantLabProviderTestResult {
  ok: boolean
  symbol: string
  timeframe: QuantLabCandleTimeframe
  updatedAt: string
  envPath: string
  status: 'OK' | 'PARTIAL' | 'FAILED' | 'MISSING_KEY'
  tests: QuantLabProviderTestRow[]
}

export interface SaveQuantLabReportPayload {
  content: string
  fileName?: string
}

export interface SaveQuantLabReportResult {
  ok: boolean
  path: string
  relativePath: string
}

export interface QuantLabAuditSnapshotEntry {
  fileName: string
  path: string
  relativePath: string
  kind?: 'audit-snapshot' | 'batch-markdown' | 'batch-csv' | 'compare-markdown'
  categoryLabel?: string
  extension?: string
  title: string
  summary: string
  signal: string
  confidence: string
  driftScore: string
  createdAt: string
  mtimeMs: number
  content: string
}

export interface QuantLabAuditSnapshotsResult {
  ok: boolean
  entries: QuantLabAuditSnapshotEntry[]
  path: string
  relativePath: string
  updatedAt: string
}

export interface SendQuantLabTelegramPayload {
  text: string
}

export interface SendQuantLabTelegramResult {
  ok: boolean
  chatId?: string
  skipped?: boolean
  reason?: string
  notificationId?: string
  severity?: QuantLabNotificationSeverity
}

export type QuantLabBriefPhase = 'premarket' | 'afterclose'
export type QuantLabPaperAction = 'BUY' | 'SELL' | 'MARK' | 'RESET' | 'JOURNAL'
export type QuantLabMiroFishInferenceStatus = 'not_run' | 'seed_saved' | 'backend_unavailable' | 'backend_available' | 'submitted' | 'report_ready' | 'error'
export type QuantLabMiroFishConfidence = 'low' | 'medium' | 'high'

export interface RunQuantLabBriefPayload {
  phase: QuantLabBriefPhase
  saveReport?: boolean
  sendTelegram?: boolean
  forceTelegram?: boolean
  submitMiroFish?: boolean
}

export interface QuantLabMiroFishSeed {
  status: string
  fileName?: string
  path: string
  relativePath: string
  updatedAt?: string
  size?: number
}

export interface QuantLabMiroFishScenarioJudgement {
  probability: number
  confidence: number
  reasoning: string
}

export interface QuantLabMiroFishDebateArgument {
  role: 'macro' | 'bull' | 'bear' | 'judge'
  title: string
  content: string
  citations: string[]
  generatedAt: string
}

export interface QuantLabMiroFishMacro {
  Regime: 'Risk-On' | 'Chop' | 'Risk-Off' | string
  RiskMultiplier: number
  MacroInsight: string
}

export interface QuantLabMiroFishDebate {
  macro: QuantLabMiroFishMacro
  scenarios: {
    bullish: QuantLabMiroFishScenarioJudgement
    neutral: QuantLabMiroFishScenarioJudgement
    bearish: QuantLabMiroFishScenarioJudgement
  }
  key_risks: string[]
  bull: QuantLabMiroFishDebateArgument
  bear: QuantLabMiroFishDebateArgument
  judgeRaw: string
  mode: 'local' | 'model' | 'safe-fallback'
  ok: boolean
  error?: string
  generatedAt: string
}

export interface QuantLabMiroFishInference {
  status: QuantLabMiroFishInferenceStatus
  confidence: QuantLabMiroFishConfidence
  support: string[]
  oppose: string[]
  neutral: string[]
  debate?: QuantLabMiroFishDebate
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

export interface QuantLabMiroFishGraphTaskStatus {
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

export interface QuantLabMiroFishGraphEdgeSummary {
  source: string
  target: string
  type: string
  fact?: string
}

export interface QuantLabMiroFishGraphSummary {
  ok: boolean
  backendUrl: string
  checkedAt: string
  graphId?: string
  source: 'backend' | 'local-file' | 'none'
  nodeCount: number
  edgeCount: number
  nodeTypes: Array<{ label: string; count: number }>
  edgeTypes: Array<{ label: string; count: number }>
  trackedNodes: Array<{ symbol: string; present: boolean; degree: number; name?: string; labels?: string[]; summary?: string; relatedEdges?: QuantLabMiroFishGraphEdgeSummary[] }>
  topNodes: Array<{ name: string; degree: number; labels: string[]; summary?: string }>
  sampleEdges: QuantLabMiroFishGraphEdgeSummary[]
  error?: string
}

export interface QuantLabMiroFishEvidenceArchive {
  path: string
  relativePath: string
  graphOk: boolean
  graphId?: string
  graphSource?: QuantLabMiroFishGraphSummary['source']
  journalNote: string
  topDegrees: Array<{ ticker: string; degree: number }>
}

export interface QuantLabEvidenceArchiveEntry {
  fileName: string
  path: string
  relativePath: string
  title: string
  createdAt: string
  updatedAt: string
  phase?: QuantLabBriefPhase
  status?: string
  confidence?: QuantLabMiroFishConfidence
  source?: string
  graphOk: boolean
  graphId?: string
  graphSource?: QuantLabMiroFishGraphSummary['source'] | string
  nodeCount?: number
  edgeCount?: number
  evidenceCount?: number
  topDegrees: Array<{ ticker: string; degree: number }>
  support?: string
  oppose?: string
  summary: string
  size: number
}

export interface QuantLabEvidenceArchiveList {
  ok: boolean
  entries: QuantLabEvidenceArchiveEntry[]
  path: string
  relativePath: string
  updatedAt: string
}

export interface QuantLabMiroFishMemoryRecord {
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

export interface QuantLabMiroFishMemoryRecordsResult {
  ok: boolean
  records: QuantLabMiroFishMemoryRecord[]
  directories: string[]
  path: string
  relativePath: string
  updatedAt: string
  error?: string
}

export interface QuantLabMiroFishMemoryWriteResult {
  fileName: string
  path: string
  relativePath: string
  topic: string
  verdict: string
  date: string
}

export interface QuantLabPostMortemReport {
  id: string
  ticker: string
  fileName: string
  date: string
  result: 'Win' | 'Loss' | 'Flat' | 'Unknown'
  pnlPct: number | null
  pnl?: number | null
  vix: number | null
  actionableInsight: string
  markdown: string
  path: string
  relativePath?: string
  agentScores: {
    quant: number | null
    bull: number | null
    bear: number | null
  }
  updatedAt: string
}

export interface QuantLabPostMortemsResult {
  ok: boolean
  path: string
  entries: QuantLabPostMortemReport[]
  count: number
  updatedAt: string
}

export interface RunQuantLabBriefResult {
  ok: boolean
  phase: QuantLabBriefPhase
  source: string
  generatedAt: string
  saved: {
    path: string
    relativePath: string
  } | null
  telegram: {
    ok: boolean
    chatId?: string
    error?: string
    code?: string
    skipped?: boolean
    reason?: string
    notificationId?: string
    severity?: QuantLabNotificationSeverity
  } | null
  notification?: QuantLabNotificationDispatchResult | null
  mirofish?: {
    status: string
    seed?: QuantLabMiroFishSeed
    requirement?: string
    inference?: QuantLabMiroFishInference
    evidenceArchive?: QuantLabMiroFishEvidenceArchive
  }
  topPicks: QuantLabTopPick[]
  paper?: {
    equity: number
    cash: number
    returnPct: number
    dailyReturnPct?: number
    maxDrawdownPct: number
    positions: number
    statePath: string
    report?: {
      path: string
      relativePath: string
    }
  }
  summary: {
    title: string
    conclusion: string
    action: string
    invalidation: string
  }
}

export interface RunQuantLabWeeklySummaryPayload {
  saveReport?: boolean
  sendTelegram?: boolean
  forceTelegram?: boolean
}

export interface RunQuantLabWeeklySummaryResult {
  ok: boolean
  source: string
  generatedAt: string
  saved: {
    path: string
    relativePath: string
  } | null
  telegram: {
    ok: boolean
    chatId?: string
    error?: string
    code?: string
    skipped?: boolean
    reason?: string
    notificationId?: string
    severity?: QuantLabNotificationSeverity
  } | null
  sourceBriefs: Array<{
    path: string
    relativePath: string
    modifiedAt: string
    title: string
    tickers: string[]
  }>
  topPicks: QuantLabTopPick[]
  paper?: {
    equity: number
    cash: number
    returnPct: number
    dailyReturnPct?: number
    maxDrawdownPct: number
    positions: number
    statePath: string
  }
  summary: {
    title: string
    conclusion: string
    action: string
    invalidation: string
  }
}

export interface RunQuantLabMiroFishPayload {
  phase: QuantLabBriefPhase
  submitBackend?: boolean
  scenario?: string
  targetTicker?: string
  topic?: string
}

export interface RunQuantLabMiroFishResult {
  ok: boolean
  phase: QuantLabBriefPhase
  source: string
  generatedAt: string
  evidenceCount: number
  mirofish: {
    status: string
    seed?: QuantLabMiroFishSeed
    requirement?: string
    inference?: QuantLabMiroFishInference
    evidenceArchive?: QuantLabMiroFishEvidenceArchive
    memoryRecord?: QuantLabMiroFishMemoryWriteResult
  }
  topPicks: QuantLabTopPick[]
}

export const MIROFISH_SAFE_GATEWAY_ALERT = '[System Alert] Gateway parsing intercepted. Safe mode engaged.'

const MIROFISH_RAW_GATEWAY_ERROR_RE = /\bTraceback\b|\bPython\b|\bSyntaxError\b|\bJSONDecodeError\b|\bPydantic\b|\bValidationError\b|\bTypeError\b|\bValueError\b|NoneType|object is not iterable|\bInternal Server Error\b|\bHTTP\s*500\b|\bAPI Error\s*500\b/i

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value || '')
  }
}

export function isMiroFishRawGatewayError(value: unknown): boolean {
  return MIROFISH_RAW_GATEWAY_ERROR_RE.test(stringifyUnknown(value))
}

export function toMiroFishSafeErrorMessage(value: unknown, fallback = 'MiroFish sandbox entered safe mode.'): string {
  const text = stringifyUnknown(value).trim()
  if (!text) return fallback
  return isMiroFishRawGatewayError(text) ? MIROFISH_SAFE_GATEWAY_ALERT : fallback
}

function sanitizeMiroFishGatewayPayload<T>(value: T): T {
  if (typeof value === 'string') {
    return (isMiroFishRawGatewayError(value) ? MIROFISH_SAFE_GATEWAY_ALERT : value) as T
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeMiroFishGatewayPayload(item)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        sanitizeMiroFishGatewayPayload(child),
      ])
    ) as T
  }
  return value
}

function fallbackTicker(payload: RunQuantLabMiroFishPayload): string {
  const ticker = String(payload.targetTicker || '').trim().toUpperCase()
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : 'MARKET'
}

export function buildMiroFishSafeFallbackResult(payload: RunQuantLabMiroFishPayload): RunQuantLabMiroFishResult {
  const generatedAt = new Date().toISOString()
  const ticker = fallbackTicker(payload)
  const scenarios = {
    bullish: {
      probability: 0.2,
      confidence: 0.35,
      reasoning: `${MIROFISH_SAFE_GATEWAY_ALERT} Upside case is observation-only until the gateway is healthy.`,
    },
    neutral: {
      probability: 0.6,
      confidence: 0.55,
      reasoning: 'Safe mode defaults to WATCH so the UI can render without issuing trade guidance.',
    },
    bearish: {
      probability: 0.2,
      confidence: 0.4,
      reasoning: 'Backend parsing failed, so risk controls stay conservative and no execution path is exposed.',
    },
  }
  const debate: QuantLabMiroFishDebate = {
    macro: {
      Regime: 'Chop',
      RiskMultiplier: 0.5,
      MacroInsight: `${MIROFISH_SAFE_GATEWAY_ALERT} Local fallback macro gate is neutral-to-defensive.`,
    },
    scenarios,
    key_risks: [MIROFISH_SAFE_GATEWAY_ALERT, 'Gateway health must be restored before trusting model-generated debate output.'],
    bull: {
      role: 'bull',
      title: 'Safe Mode Bull Agent',
      content: `${ticker} remains on a research watchlist only. Re-run the debate after gateway recovery for a full bull thesis.`,
      citations: [],
      generatedAt,
    },
    bear: {
      role: 'bear',
      title: 'Safe Mode Bear Agent',
      content: 'Fallback defense is active: no real trades, no backend submit, and no raw gateway stack traces shown to the user.',
      citations: [],
      generatedAt,
    },
    judgeRaw: JSON.stringify({ scenarios, key_risks: [MIROFISH_SAFE_GATEWAY_ALERT] }),
    mode: 'safe-fallback',
    ok: false,
    error: MIROFISH_SAFE_GATEWAY_ALERT,
    generatedAt,
  }

  return {
    ok: false,
    phase: payload.phase,
    source: 'aurora-safe-mode',
    generatedAt,
    evidenceCount: 0,
    mirofish: {
      status: 'safe_mode',
      requirement: MIROFISH_SAFE_GATEWAY_ALERT,
      inference: {
        status: 'report_ready',
        confidence: 'low',
        support: [`${ticker} fallback watchlist hydrated.`],
        oppose: ['Gateway parsing was intercepted before raw technical errors reached the UI.'],
        neutral: [MIROFISH_SAFE_GATEWAY_ALERT],
        debate,
        evidenceCount: 0,
        error: MIROFISH_SAFE_GATEWAY_ALERT,
        updatedAt: generatedAt,
      },
    },
    topPicks: [
      {
        ticker,
        score: 0,
        action: 'WATCH',
        trend: 'safe-mode',
        risk: 'H',
        reason: 'Aurora safe fallback: gateway parsing intercepted; research-only watch state.',
        price: 0,
      },
    ],
  }
}

function normalizeMiroFishGatewayResult(result: RunQuantLabMiroFishResult, payload: RunQuantLabMiroFishPayload): RunQuantLabMiroFishResult {
  if (!result || typeof result !== 'object' || !result.mirofish) {
    return buildMiroFishSafeFallbackResult(payload)
  }
  return sanitizeMiroFishGatewayPayload(result)
}

export interface QuantLabNotificationEntry {
  id: string
  createdAt: string
  kind: QuantLabNotificationKind
  severity: QuantLabNotificationSeverity
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

export interface QuantLabNotificationDispatchResult {
  ok: boolean
  sent: boolean
  skipped: boolean
  reason?: string
  entry?: QuantLabNotificationEntry
  path: string
  relativePath: string
}

export interface QuantLabNotificationsResult {
  ok: boolean
  entries: QuantLabNotificationEntry[]
  path: string
  relativePath: string
}

export interface EvaluateQuantLabNotificationsPayload {
  sendTelegram?: boolean
  source?: string
}

export interface EvaluateQuantLabNotificationsResult {
  ok: boolean
  source: string
  generatedAt: string
  notification: QuantLabNotificationDispatchResult | null
  guardrails?: QuantLabPaperGuardrails
}

export interface QuantLabPaperPosition {
  ticker: string
  shares: number
  avgCost: number
  lastPrice: number
  stop: string
}

export interface QuantLabPaperJournalEntry {
  time: string
  ticker: string
  action: string
  note: string
}

export type QuantLabRiskCheckStatus = 'PASS' | 'WARN' | 'BLOCK'

export interface QuantLabRiskCheck {
  key: string
  label: string
  status: QuantLabRiskCheckStatus
  value: string
  reason: string
  blocksNewBuys?: boolean
}

export interface QuantLabPaperGuardrails {
  tradingDate: string
  dayStartEquity: number
  dailyReturnPct: number
  consecutiveLosses: number
  pauseNewBuysUntil: string | null
  buysToday: Record<string, string>
  status: 'OK' | 'BLOCKED'
  reason: string
  lastGuardrail: string | null
  checks?: QuantLabRiskCheck[]
  prohibited?: string[]
  generatedAt?: string
}

export interface QuantLabPaperAccount {
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
  positions: QuantLabPaperPosition[]
  journal: QuantLabPaperJournalEntry[]
  equity: number
  returnPct: number
  dailyReturnPct?: number
  maxDrawdownPct: number
  winRate: number
  profitFactor: number | null
  guardrails?: QuantLabPaperGuardrails
  statePath: string
  report?: {
    path: string
    relativePath: string
  }
  notification?: QuantLabNotificationDispatchResult | null
}

export interface QuantLabPaperTrade {
  id: string
  ticker: string
  result: 'Win' | 'Loss' | 'Flat'
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

export interface QuantLabPaperEquityPoint {
  time: number
  value: number
}

export interface QuantLabPaperTradesResult {
  ok: boolean
  generatedAt: string
  source: string
  account: {
    equity: number
    initialCapital: number
    returnPct: number
    winRate: number
    profitFactor: number | null
    maxDrawdownPct: number
    realizedPnl: number
    tradeCount: number
    wins: number
    losses: number
  }
  trades: QuantLabPaperTrade[]
  equityCurve: QuantLabPaperEquityPoint[]
}

export interface QuantLabPaperActionPayload {
  action: QuantLabPaperAction
  ticker?: string
  journalAction?: string
  note?: string
}

export interface QuantLabActionAuditPayload {
  type: QuantLabTerminalActionType | string
  payload?: Record<string, unknown>
  raw?: string
  source?: string
  messageId?: string
  status?: 'accepted' | 'rejected'
  reason?: string
}

export interface QuantLabActionAuditResult {
  ok: boolean
  entry: QuantLabActionAuditPayload & {
    id: string
    timestamp: string
  }
  path: string
  relativePath: string
  notification?: QuantLabNotificationDispatchResult | null
}

export async function getQuantLabSnapshot(options: RequestInit & { fresh?: boolean } = {}): Promise<QuantLabSnapshot> {
  const { fresh, ...requestOptions } = options
  const query = fresh ? '?fresh=1' : ''
  return request<QuantLabSnapshot>(`/api/hermes/quant-lab/snapshot${query}`, requestOptions)
}

export async function getQuantLabPhaseValidation(params: { ensure?: boolean } = {}): Promise<QuantLabPhaseValidationReport> {
  const query = params.ensure ? '?ensure=1' : ''
  return request<QuantLabPhaseValidationReport>(`/api/hermes/quant-lab/phase-validation${query}`)
}

export async function getQuantLabCandles(params: { symbol: string; timeframe?: QuantLabCandleTimeframe; limit?: number }): Promise<QuantLabCandlesResult> {
  const query = new URLSearchParams({
    symbol: params.symbol,
    timeframe: params.timeframe || '15m',
    limit: String(params.limit || 80),
  })
  return request<QuantLabCandlesResult>(`/api/hermes/quant-lab/candles?${query.toString()}`)
}

export async function getQuantLabProviderSettings(): Promise<QuantLabProviderSettings> {
  return request<QuantLabProviderSettings>('/api/hermes/quant-lab/provider-settings')
}

export async function saveQuantLabProviderSettings(payload: SaveQuantLabProviderSettingsPayload): Promise<QuantLabProviderSettings> {
  return request<QuantLabProviderSettings>('/api/hermes/quant-lab/provider-settings', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function testQuantLabProviderFeeds(payload: { symbol?: string; timeframe?: QuantLabCandleTimeframe }): Promise<QuantLabProviderTestResult> {
  return request<QuantLabProviderTestResult>('/api/hermes/quant-lab/provider-test', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function getQuantLabPaperAccount(): Promise<QuantLabPaperAccount> {
  return request<QuantLabPaperAccount>('/api/hermes/quant-lab/paper-account')
}

export async function getQuantLabPaperTrades(): Promise<QuantLabPaperTradesResult> {
  return request<QuantLabPaperTradesResult>('/api/hermes/quant-lab/paper-trades')
}

export async function getQuantLabPostMortems(limit = 50): Promise<QuantLabPostMortemsResult> {
  return request<QuantLabPostMortemsResult>(`/api/hermes/quant-lab/post-mortems?limit=${encodeURIComponent(String(limit))}`)
}

export async function updateQuantLabPaperAccount(payload: QuantLabPaperActionPayload): Promise<QuantLabPaperAccount> {
  return request<QuantLabPaperAccount>('/api/hermes/quant-lab/paper-account/action', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function auditQuantLabAction(payload: QuantLabActionAuditPayload): Promise<QuantLabActionAuditResult> {
  return request<QuantLabActionAuditResult>('/api/hermes/quant-lab/action-audit', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function runQuantLabBrief(payload: RunQuantLabBriefPayload): Promise<RunQuantLabBriefResult> {
  return request<RunQuantLabBriefResult>('/api/hermes/quant-lab/run-brief', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function runQuantLabWeeklySummary(payload: RunQuantLabWeeklySummaryPayload): Promise<RunQuantLabWeeklySummaryResult> {
  return request<RunQuantLabWeeklySummaryResult>('/api/hermes/quant-lab/run-weekly-summary', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function runQuantLabMiroFish(payload: RunQuantLabMiroFishPayload): Promise<RunQuantLabMiroFishResult> {
  try {
    const result = await request<RunQuantLabMiroFishResult>('/api/hermes/quant-lab/run-mirofish', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return normalizeMiroFishGatewayResult(result, payload)
  } catch (err) {
    if (isMiroFishRawGatewayError(err)) {
      return buildMiroFishSafeFallbackResult(payload)
    }
    throw err
  }
}

export async function getQuantLabMiroFishTaskStatus(params: { taskId?: string; projectId?: string } = {}): Promise<QuantLabMiroFishGraphTaskStatus> {
  const query = new URLSearchParams()
  if (params.taskId) query.set('taskId', params.taskId)
  if (params.projectId) query.set('projectId', params.projectId)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request<QuantLabMiroFishGraphTaskStatus>(`/api/hermes/quant-lab/mirofish-task-status${suffix}`)
}

export async function getQuantLabMiroFishGraphSummary(params: { graphId?: string } = {}): Promise<QuantLabMiroFishGraphSummary> {
  const query = new URLSearchParams()
  if (params.graphId) query.set('graphId', params.graphId)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request<QuantLabMiroFishGraphSummary>(`/api/hermes/quant-lab/mirofish-graph-summary${suffix}`)
}

export async function getQuantLabEvidenceArchives(limit = 24): Promise<QuantLabEvidenceArchiveList> {
  return request<QuantLabEvidenceArchiveList>(`/api/hermes/quant-lab/mirofish-evidence-archives?limit=${encodeURIComponent(String(limit))}`)
}

export async function getQuantLabMiroFishMemoryRecords(limit = 80): Promise<QuantLabMiroFishMemoryRecordsResult> {
  return request<QuantLabMiroFishMemoryRecordsResult>(`/api/hermes/quant-lab/mirofish-memory-records?limit=${encodeURIComponent(String(limit))}`)
}

export async function getQuantLabNotifications(limit = 80): Promise<QuantLabNotificationsResult> {
  return request<QuantLabNotificationsResult>(`/api/hermes/quant-lab/notifications?limit=${encodeURIComponent(String(limit))}`)
}

export async function evaluateQuantLabNotifications(payload: EvaluateQuantLabNotificationsPayload): Promise<EvaluateQuantLabNotificationsResult> {
  return request<EvaluateQuantLabNotificationsResult>('/api/hermes/quant-lab/notifications/evaluate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function saveQuantLabReport(payload: SaveQuantLabReportPayload): Promise<SaveQuantLabReportResult> {
  return request<SaveQuantLabReportResult>('/api/hermes/quant-lab/save-report', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function getQuantLabAuditSnapshots(limit = 12): Promise<QuantLabAuditSnapshotsResult> {
  return request<QuantLabAuditSnapshotsResult>(`/api/hermes/quant-lab/audit-snapshots?limit=${encodeURIComponent(String(limit))}`)
}

export async function sendQuantLabTelegram(payload: SendQuantLabTelegramPayload): Promise<SendQuantLabTelegramResult> {
  return request<SendQuantLabTelegramResult>('/api/hermes/quant-lab/send-telegram', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
