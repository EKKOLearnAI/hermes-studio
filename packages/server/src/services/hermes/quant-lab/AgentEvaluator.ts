export interface AgentCredibilityScores {
  quant: number
  bull: number
  bear: number
}

export interface AgentHistoricalSeed {
  ticker: string
  createdAt?: string
  quantScore: number
  quantAction?: string
  quantReason?: string
  quantSource?: string
  mirofish?: {
    bullishProbability?: number
    bullishConfidence?: number
    bullishReasoning?: string
    bearishProbability?: number
    bearishConfidence?: number
    bearishReasoning?: string
    neutralProbability?: number
    neutralConfidence?: number
  } | null
  seedRelativePath?: string
  reportRelativePath?: string
  inferenceStatus?: string
  decisionExpectedScore?: number | null
  credibilityBefore?: AgentCredibilityScores
}

export interface ClosedPaperTrade {
  ticker: string
  pnl: number
  pnlPct: number
  shares?: number
  entryPrice?: number
  exitPrice?: number
  openedAt?: string
  closedAt?: string
  note?: string
}

export interface AgentScoreDelta {
  agent: 'quant' | 'bull' | 'bear'
  before: number
  delta: number
  after: number
  rationale: string
}

export interface AgentEvaluationResult {
  id: string
  ticker: string
  result: 'Win' | 'Loss' | 'Flat'
  pnl: number
  pnlPct: number
  quantContribution: AgentScoreDelta
  bullPrediction: AgentScoreDelta & { verdict: 'Accurate' | 'Inaccurate' | 'Weak Signal' }
  bearWarning: AgentScoreDelta & { verdict: 'Ignored' | 'Accurate' | 'Inaccurate' | 'Not Present' }
  updatedCredibility: AgentCredibilityScores
  actionableInsight: string
  markdown: string
}

export const DEFAULT_AGENT_CREDIBILITY: AgentCredibilityScores = {
  quant: 50,
  bull: 50,
  bear: 50,
}

export function evaluateTrade(
  closedTrade: ClosedPaperTrade,
  historicalSeed: AgentHistoricalSeed,
  currentCredibility?: Partial<AgentCredibilityScores> | null
): AgentEvaluationResult {
  const ticker = normalizeTicker(closedTrade.ticker || historicalSeed.ticker)
  const before = normalizeCredibility(currentCredibility || historicalSeed.credibilityBefore)
  const pnl = finiteOr(closedTrade.pnl, 0)
  const pnlPct = finiteOr(closedTrade.pnlPct, 0)
  const result = pnl > 0 ? 'Win' : pnl < 0 ? 'Loss' : 'Flat'
  const quantForecast = clamp(finiteOr(historicalSeed.quantScore, 0) / 100, 0, 1)
  const bullForecast = clamp(
    finiteOr(historicalSeed.mirofish?.bullishProbability, 0) *
    finiteOr(historicalSeed.mirofish?.bullishConfidence, 0),
    0,
    1
  )
  const bearForecast = clamp(
    finiteOr(historicalSeed.mirofish?.bearishProbability, 0) *
    finiteOr(historicalSeed.mirofish?.bearishConfidence, 0),
    0,
    1
  )

  const outcomeWin = result === 'Win' ? 1 : 0
  const outcomeLoss = result === 'Loss' ? 1 : 0
  const quantDelta = result === 'Flat' ? 0 : brierDelta(quantForecast, outcomeWin, 8)
  const bullDelta = result === 'Flat' ? 0 : brierDelta(bullForecast, outcomeWin, 8)
  const bearDelta = result === 'Flat' ? 0 : brierDelta(bearForecast, outcomeLoss, 10)
  const updatedCredibility = {
    quant: clampScore(before.quant + quantDelta),
    bull: clampScore(before.bull + bullDelta),
    bear: clampScore(before.bear + bearDelta),
  }

  const quantContribution: AgentScoreDelta = {
    agent: 'quant',
    before: before.quant,
    delta: quantDelta,
    after: updatedCredibility.quant,
    rationale: result === 'Win'
      ? `Quant score ${historicalSeed.quantScore.toFixed(1)} supported a winning setup.`
      : result === 'Loss'
        ? `Quant score ${historicalSeed.quantScore.toFixed(1)} overstated the edge on a losing setup.`
        : 'Flat exit; no material Quant credibility change.',
  }
  const bullPrediction = {
    agent: 'bull' as const,
    before: before.bull,
    delta: bullDelta,
    after: updatedCredibility.bull,
    verdict: bullVerdict(result, bullForecast),
    rationale: result === 'Win'
      ? `Bull signal ${(bullForecast * 100).toFixed(1)}% aligned with a profitable close.`
      : result === 'Loss'
        ? `Bull signal ${(bullForecast * 100).toFixed(1)}% failed to protect against the loss.`
        : 'Flat exit; Bull signal is treated as inconclusive.',
  }
  const bearWarning = {
    agent: 'bear' as const,
    before: before.bear,
    delta: bearDelta,
    after: updatedCredibility.bear,
    verdict: bearVerdict(result, bearForecast),
    rationale: result === 'Loss'
      ? `Bear warning ${(bearForecast * 100).toFixed(1)}% correctly identified downside pressure.`
      : result === 'Win'
        ? `Bear warning ${(bearForecast * 100).toFixed(1)}% was too defensive for a winning setup.`
        : 'Flat exit; Bear warning is treated as inconclusive.',
  }
  const actionableInsight = buildActionableInsight({ result, historicalSeed, bullForecast, bearForecast, pnlPct })
  const evaluation: Omit<AgentEvaluationResult, 'markdown'> = {
    id: `${new Date(closedTrade.closedAt || Date.now()).toISOString().replace(/[:.]/g, '-')}-${ticker}`,
    ticker,
    result,
    pnl,
    pnlPct,
    quantContribution,
    bullPrediction,
    bearWarning,
    updatedCredibility,
    actionableInsight,
  }

  return {
    ...evaluation,
    markdown: buildPostMortemMarkdown(evaluation, closedTrade, historicalSeed),
  }
}

function buildPostMortemMarkdown(
  evaluation: Omit<AgentEvaluationResult, 'markdown'>,
  closedTrade: ClosedPaperTrade,
  historicalSeed: AgentHistoricalSeed
): string {
  const resultLabel = `${evaluation.result} (${formatSigned(evaluation.pnlPct)}%)`
  const opened = closedTrade.openedAt || historicalSeed.createdAt || 'n/a'
  const closed = closedTrade.closedAt || new Date().toISOString()
  const mirofish = historicalSeed.mirofish || {}

  return `# Trade Post-Mortem: ${evaluation.ticker}

- **Result:** ${resultLabel}
- **Closed P/L:** ${formatMoney(evaluation.pnl)}
- **Opened:** ${opened}
- **Closed:** ${closed}
- **Entry / Exit:** ${formatMaybeMoney(closedTrade.entryPrice)} -> ${formatMaybeMoney(closedTrade.exitPrice)}
- **Quant Contribution:** ${formatDelta(evaluation.quantContribution.delta)} (${evaluation.quantContribution.rationale})
- **Bull Agent Prediction:** ${evaluation.bullPrediction.verdict} -> ${formatDelta(evaluation.bullPrediction.delta)} (${evaluation.bullPrediction.rationale})
- **Bear Agent Warning:** ${evaluation.bearWarning.verdict} -> ${formatDelta(evaluation.bearWarning.delta)} (${evaluation.bearWarning.rationale})
- **Actionable Insight:** ${evaluation.actionableInsight}

## Historical Seed

- Quant score: ${historicalSeed.quantScore.toFixed(1)}
- Quant action: ${historicalSeed.quantAction || 'n/a'}
- Quant source: ${historicalSeed.quantSource || 'n/a'}
- Bull probability/confidence: ${formatRatio(mirofish.bullishProbability)} / ${formatRatio(mirofish.bullishConfidence)}
- Bear probability/confidence: ${formatRatio(mirofish.bearishProbability)} / ${formatRatio(mirofish.bearishConfidence)}
- MiroFish seed: ${historicalSeed.seedRelativePath || 'n/a'}
- MiroFish report: ${historicalSeed.reportRelativePath || 'n/a'}

## Updated Agent Credibility

| Agent | Score |
|---|---:|
| Quant | ${evaluation.updatedCredibility.quant.toFixed(2)} |
| Bull | ${evaluation.updatedCredibility.bull.toFixed(2)} |
| Bear | ${evaluation.updatedCredibility.bear.toFixed(2)} |
`
}

function buildActionableInsight(input: {
  result: 'Win' | 'Loss' | 'Flat'
  historicalSeed: AgentHistoricalSeed
  bullForecast: number
  bearForecast: number
  pnlPct: number
}): string {
  if (input.result === 'Loss' && input.bearForecast >= 0.35) {
    return `未來若 Bear warning 高於 ${(input.bearForecast * 100).toFixed(0)}% 且 Quant 仍高分，先降倉或要求下一個交易日確認，不要直接放大部位。`
  }
  if (input.result === 'Loss') {
    return '未來遇到相同型態時，若價格沒有快速驗證 thesis，優先縮短觀察期並降低單筆部位。'
  }
  if (input.result === 'Win' && input.bullForecast >= 0.35) {
    return '高 Quant 分數且 Bull 情境同步時可以保留 paper thesis，但仍需讓風控限制單檔與同板塊曝險。'
  }
  if (input.result === 'Win') {
    return '獲利但 Bull 支持不強，未來應檢查是否主要來自市場 beta，而非個股 thesis。'
  }
  return '平盤結果不更新核心假設，下一次應要求更清楚的突破、回測或風險改善證據。'
}

function brierDelta(forecast: number, outcome: number, scale: number): number {
  const baseline = 0.25
  const error = Math.pow(forecast - outcome, 2)
  return round2((baseline - error) * scale)
}

function bullVerdict(result: 'Win' | 'Loss' | 'Flat', forecast: number): 'Accurate' | 'Inaccurate' | 'Weak Signal' {
  if (forecast < 0.2 || result === 'Flat') return 'Weak Signal'
  if (result === 'Win') return 'Accurate'
  return 'Inaccurate'
}

function bearVerdict(result: 'Win' | 'Loss' | 'Flat', forecast: number): 'Ignored' | 'Accurate' | 'Inaccurate' | 'Not Present' {
  if (forecast < 0.2 || result === 'Flat') return 'Not Present'
  if (result === 'Loss') return 'Ignored'
  return 'Inaccurate'
}

function normalizeCredibility(value?: Partial<AgentCredibilityScores> | null): AgentCredibilityScores {
  return {
    quant: clampScore(finiteOr(value?.quant, DEFAULT_AGENT_CREDIBILITY.quant)),
    bull: clampScore(finiteOr(value?.bull, DEFAULT_AGENT_CREDIBILITY.bull)),
    bear: clampScore(finiteOr(value?.bear, DEFAULT_AGENT_CREDIBILITY.bear)),
  }
}

function normalizeTicker(value: string): string {
  return String(value || '').trim().toUpperCase()
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampScore(value: number): number {
  return round2(clamp(value, 0, 100))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function formatSigned(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}`
}

function formatDelta(value: number): string {
  return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2)
}

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

function formatMaybeMoney(value: number | undefined): string {
  return Number.isFinite(value) ? formatMoney(Number(value)) : 'n/a'
}

function formatRatio(value: number | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(2) : 'n/a'
}
