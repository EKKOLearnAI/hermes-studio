export type HermesSynthesisAction = 'BUY' | 'WATCH' | 'REJECT' | 'SELL'

export interface HermesSynthesizerWeights {
  w1: number
  w2: number
  w3: number
}

export type HermesWeightRegime = 'risk-on' | 'neutral-chop' | 'risk-off'

export interface HermesDynamicWeightProfile {
  regime: HermesWeightRegime
  label: string
  vix: number
  weights: HermesSynthesizerWeights
}

export interface HermesSynthesizerScenario {
  probability: number
  confidence: number
  reasoning?: string
}

export interface HermesSynthesizerMiroFishResult {
  scenarios?: {
    bullish?: HermesSynthesizerScenario
    neutral?: HermesSynthesizerScenario
    bearish?: HermesSynthesizerScenario
  }
  macro?: {
    Regime?: 'Risk-On' | 'Chop' | 'Risk-Off' | string
    RiskMultiplier?: number
    MacroInsight?: string
  }
  key_risks?: string[]
}

export interface HermesSynthesizerInput {
  ticker: string
  quantScore: number
  mirofishResult?: HermesSynthesizerMiroFishResult | null
  macroRisk: number
  vix?: number | null
  weights?: Partial<HermesSynthesizerWeights>
  price?: number
  availableCash?: number
  maxTradeValue?: number
  minTradeValue?: number
  currentPositions?: HermesPortfolioPosition[]
  portfolioValue?: number
  sectorMap?: Record<string, string>
}

export interface HermesSynthesizerActionPayload {
  type: 'SIMULATE_TRADE'
  action: 'BUY'
  side: 'BUY'
  ticker: string
  qty: number
}

export interface HermesSynthesizerResult {
  ticker: string
  action: HermesSynthesisAction
  expectedScore: number
  quantScore: number
  mirofishScore: number
  macroRisk: number
  vix: number
  riskMultiplier: number
  macroRegime: string
  macroInsight: string
  weights: HermesSynthesizerWeights
  weightRegime: HermesWeightRegime
  weightRegimeLabel: string
  qty: number
  terminalMessage: string
  actionPayload?: HermesSynthesizerActionPayload
  portfolioExposure: PortfolioExposureCheckResult
  formula: string
  reasons: string[]
}

export interface HermesPortfolioPosition {
  ticker: string
  value: number
  sector?: string
}

export interface PortfolioExposureCheckInput {
  currentPositions: HermesPortfolioPosition[]
  targetTicker: string
  portfolioValue?: number
  sectorMap?: Record<string, string>
  maxSectorPositions?: number
  maxSectorWeight?: number
}

export interface PortfolioExposureCheckResult {
  allowed: boolean
  sector: string
  sectorPositionCount: number
  sectorValue: number
  sectorWeight: number
  reason: string
}

export interface MacroRiskPressureInput {
  vixPrice?: number | null
  vixPct?: number | null
  qqqPct?: number | null
  tnxYield?: number | null
  tnxYieldChange?: number | null
  riskStatus?: string
  dataStatus?: string
}

export const DEFAULT_SECTOR_MAP: Record<string, string> = {
  NVDA: 'SEMIS',
  AMD: 'SEMIS',
  AVGO: 'SEMIS',
  TSM: 'SEMIS',
  ASML: 'SEMIS',
  ARM: 'SEMIS',
  QCOM: 'SEMIS',
  TXN: 'SEMIS',
  AMAT: 'SEMIS',
  LRCX: 'SEMIS',
  MU: 'SEMIS',
  INTC: 'SEMIS',
  MRVL: 'SEMIS',
  MCHP: 'SEMIS',
  ADI: 'SEMIS',
  KLAC: 'SEMIS',
  MPWR: 'SEMIS',
  MSFT: 'SOFTWARE',
  GOOGL: 'SOFTWARE',
  CRM: 'SOFTWARE',
  NOW: 'SOFTWARE',
  ADBE: 'SOFTWARE',
  ORCL: 'SOFTWARE',
  PANW: 'SOFTWARE',
  CRWD: 'SOFTWARE',
  PLTR: 'SOFTWARE',
  SNOW: 'SOFTWARE',
  NET: 'SOFTWARE',
  DDOG: 'SOFTWARE',
  META: 'COMMUNICATIONS',
  NFLX: 'COMMUNICATIONS',
  AMZN: 'CONSUMER',
  TSLA: 'CONSUMER',
  COST: 'STAPLES',
  LLY: 'HEALTHCARE',
  UNH: 'HEALTHCARE',
  JPM: 'FINANCIALS',
}

export class HermesSynthesizer {
  synthesize(input: HermesSynthesizerInput): HermesSynthesizerResult {
    const ticker = normalizeTicker(input.ticker)
    const weightProfile = calculateDynamicWeightProfile(input.vix)
    const weights = normalizeWeights(input.weights, weightProfile.weights)
    const quantScore = clamp(finiteOr(input.quantScore, 0), 0, 100)
    const mirofishScore = calculateMiroFishScenarioScore(input.mirofishResult)
    const macroGate = normalizeMiroFishMacroGate(input.mirofishResult)
    const macroRisk = clamp(finiteOr(input.macroRisk, 100), 0, 100)
    console.info(
      `[HermesSynthesizer] marketRegime=${weightProfile.label} vix=${weightProfile.vix.toFixed(2)} weights=` +
      `w1:${weights.w1.toFixed(2)} w2:${weights.w2.toFixed(2)} w3:${weights.w3.toFixed(2)}`
    )
    const preMultiplierScore = round2(
      (weights.w1 * quantScore) +
      (weights.w2 * mirofishScore) -
      (weights.w3 * macroRisk)
    )
    const expectedScore = round2(preMultiplierScore * macroGate.riskMultiplier)
    const rawAction = decideAction(expectedScore, macroRisk)
    const portfolioExposure = checkPortfolioExposure({
      currentPositions: input.currentPositions || [],
      targetTicker: ticker,
      portfolioValue: input.portfolioValue,
      sectorMap: input.sectorMap,
    })
    const action = rawAction === 'BUY' && !portfolioExposure.allowed ? 'WATCH' : rawAction
    const qty = action === 'BUY' ? calculatePaperQty(input) : 0
    const actionPayload = action === 'BUY'
      ? { type: 'SIMULATE_TRADE' as const, action: 'BUY' as const, side: 'BUY' as const, ticker, qty }
      : undefined
    const reasons = buildReasons({ expectedScore, quantScore, mirofishScore, macroRisk, action, qty, portfolioExposure, rawAction, weights, weightProfile, macroGate, preMultiplierScore })
    const terminalMessage = buildTerminalMessage({ ticker, action, expectedScore, quantScore, mirofishScore, macroRisk, qty, actionPayload, portfolioExposure, rawAction, weights, weightProfile, macroGate, preMultiplierScore })

    return {
      ticker,
      action,
      expectedScore,
      quantScore,
      mirofishScore,
      macroRisk,
      vix: weightProfile.vix,
      riskMultiplier: macroGate.riskMultiplier,
      macroRegime: macroGate.regime,
      macroInsight: macroGate.insight,
      weights,
      weightRegime: weightProfile.regime,
      weightRegimeLabel: weightProfile.label,
      qty,
      terminalMessage,
      actionPayload,
      portfolioExposure,
      formula: 'E[S_final] = ((w1 * S_quant) + (w2 * S_mirofish) - (w3 * R_macro)) * RiskMultiplier',
      reasons,
    }
  }
}

export function synthesizeHermesDecision(input: HermesSynthesizerInput): HermesSynthesizerResult {
  return new HermesSynthesizer().synthesize(input)
}

export function calculateDynamicWeights(vix: number): HermesSynthesizerWeights {
  return calculateDynamicWeightProfile(vix).weights
}

export function calculateDynamicWeightProfile(vixInput?: number | null): HermesDynamicWeightProfile {
  const vix = Math.max(0, finiteOr(vixInput ?? undefined, 0))
  if (vix < 18) {
    return {
      regime: 'risk-on',
      label: 'Risk-On',
      vix,
      weights: { w1: 0.6, w2: 0.3, w3: 0.1 },
    }
  }
  if (vix <= 25) {
    return {
      regime: 'neutral-chop',
      label: 'Neutral/Chop',
      vix,
      weights: { w1: 0.3, w2: 0.5, w3: 0.2 },
    }
  }
  return {
    regime: 'risk-off',
    label: 'Risk-Off',
    vix,
    weights: { w1: 0.1, w2: 0.2, w3: 0.7 },
  }
}

export function calculateMiroFishScenarioScore(mirofishResult?: HermesSynthesizerMiroFishResult | null): number {
  const bullish = mirofishResult?.scenarios?.bullish
  const bearish = mirofishResult?.scenarios?.bearish
  const bullScore = clamp(finiteOr(bullish?.probability, 0), 0, 1) *
    clamp(finiteOr(bullish?.confidence, 0), 0, 1) *
    100
  const bearScore = clamp(finiteOr(bearish?.probability, 0), 0, 1) *
    clamp(finiteOr(bearish?.confidence, 0), 0, 1) *
    100
  return round2(bullScore - bearScore)
}

export function normalizeMiroFishMacroGate(mirofishResult?: HermesSynthesizerMiroFishResult | null): { regime: string; riskMultiplier: number; insight: string } {
  const macro = mirofishResult?.macro
  const regime = String(macro?.Regime || 'Unknown').trim() || 'Unknown'
  const riskMultiplier = round2(clamp(finiteOr(macro?.RiskMultiplier, 1), 0, 1))
  const insight = String(macro?.MacroInsight || 'Macro Agent not available; default RiskMultiplier=1.00.').trim()
  return { regime, riskMultiplier, insight }
}

export function calculateMacroRiskPressure(input: MacroRiskPressureInput): number {
  const vixPrice = finiteOr(input.vixPrice ?? undefined, 0)
  const vixPct = finiteOr(input.vixPct ?? undefined, 0)
  const qqqPct = finiteOr(input.qqqPct ?? undefined, 0)
  const tnxYield = finiteOr(input.tnxYield ?? undefined, 0)
  const tnxYieldChange = finiteOr(input.tnxYieldChange ?? undefined, 0)
  const riskStatus = String(input.riskStatus || '').toUpperCase()
  const dataStatus = String(input.dataStatus || '').toUpperCase()

  let risk = 15
  if (vixPrice >= 20) risk += 38
  else if (vixPrice >= 17) risk += 18
  else if (vixPrice >= 15) risk += 8
  if (vixPct > 0) risk += Math.min(18, vixPct * 3)

  if (qqqPct < -2) risk += 24
  else if (qqqPct < 0) risk += Math.min(16, Math.abs(qqqPct) * 6)

  if (tnxYield >= 4.75) risk += 18
  else if (tnxYield >= 4.4) risk += 10
  if (tnxYieldChange > 0) risk += Math.min(14, tnxYieldChange * 35)

  if (riskStatus.includes('BLOCK')) risk += 22
  else if (riskStatus.includes('WARN')) risk += 10

  if (['DEGRADED', 'FALLBACK'].includes(dataStatus)) risk += 10
  if (dataStatus === 'ERROR') risk += 25

  return round2(clamp(risk, 0, 100))
}

export function checkPortfolioExposure(input: PortfolioExposureCheckInput): PortfolioExposureCheckResult {
  const targetTicker = normalizeTicker(input.targetTicker)
  const sectorMap = { ...DEFAULT_SECTOR_MAP, ...(input.sectorMap || {}) }
  const sector = getPortfolioSectorForTicker(targetTicker, sectorMap)
  const maxSectorPositions = finiteOr(input.maxSectorPositions, 2)
  const maxSectorWeight = finiteOr(input.maxSectorWeight, 0.4)
  const normalizedPositions = (input.currentPositions || [])
    .map(position => ({
      ticker: normalizeTicker(position.ticker),
      value: Math.max(0, finiteOr(position.value, 0)),
      sector: position.sector || getPortfolioSectorForTicker(position.ticker, sectorMap),
    }))
    .filter(position => position.ticker && position.value >= 0)
  const sameSectorPositions = normalizedPositions.filter(position => position.sector === sector)
  const uniqueSameSectorTickers = new Set(sameSectorPositions.map(position => position.ticker))
  const sectorValue = round2(sameSectorPositions.reduce((sum, position) => sum + position.value, 0))
  const inferredPortfolioValue = normalizedPositions.reduce((sum, position) => sum + position.value, 0)
  const portfolioValue = Math.max(1, finiteOr(input.portfolioValue, inferredPortfolioValue || 1))
  const sectorWeight = round4(sectorValue / portfolioValue)
  const countBlocked = uniqueSameSectorTickers.size >= maxSectorPositions
  const weightBlocked = sectorWeight > maxSectorWeight

  if (countBlocked || weightBlocked) {
    const reason = countBlocked
      ? `Blocked: ${sector} sector exposure limit reached.`
      : `Blocked: ${sector} sector weight ${(sectorWeight * 100).toFixed(1)}% exceeds ${(maxSectorWeight * 100).toFixed(0)}%.`
    return {
      allowed: false,
      sector,
      sectorPositionCount: uniqueSameSectorTickers.size,
      sectorValue,
      sectorWeight,
      reason,
    }
  }

  return {
    allowed: true,
    sector,
    sectorPositionCount: uniqueSameSectorTickers.size,
    sectorValue,
    sectorWeight,
    reason: `${sector} sector exposure is within limits.`,
  }
}

export function getPortfolioSectorForTicker(ticker: string, sectorMap: Record<string, string> = DEFAULT_SECTOR_MAP): string {
  const normalized = normalizeTicker(ticker)
  return sectorMap[normalized] || 'OTHER'
}

function decideAction(expectedScore: number, macroRisk: number): HermesSynthesisAction {
  if (expectedScore > 85 && macroRisk < 50) return 'BUY'
  if (expectedScore >= 60 && expectedScore <= 85) return 'WATCH'
  return 'REJECT'
}

function calculatePaperQty(input: HermesSynthesizerInput): number {
  const price = finiteOr(input.price, 0)
  const availableCash = Math.max(0, finiteOr(input.availableCash, Number.POSITIVE_INFINITY))
  const maxTradeValue = Math.max(0, finiteOr(input.maxTradeValue, 200))
  const minTradeValue = Math.max(0, finiteOr(input.minTradeValue, 25))
  if (price <= 0) return 0
  const budget = Math.min(availableCash, maxTradeValue)
  if (budget < minTradeValue) return 0
  return round4(budget / price)
}

function buildReasons(input: {
  expectedScore: number
  quantScore: number
  mirofishScore: number
  macroRisk: number
  action: HermesSynthesisAction
  rawAction: HermesSynthesisAction
  qty: number
  portfolioExposure: PortfolioExposureCheckResult
  weights: HermesSynthesizerWeights
  weightProfile: HermesDynamicWeightProfile
  macroGate: { regime: string; riskMultiplier: number; insight: string }
  preMultiplierScore: number
}): string[] {
  const lines = [
    `VIX ${input.weightProfile.vix.toFixed(2)} selects ${input.weightProfile.label} weights w1=${input.weights.w1.toFixed(2)}, w2=${input.weights.w2.toFixed(2)}, w3=${input.weights.w3.toFixed(2)}.`,
    `Quant score ${input.quantScore.toFixed(2)} contributes the pure Phase 2 selection edge.`,
    `MiroFish score ${input.mirofishScore.toFixed(2)} converts Bull/Bear probabilities into scenario edge.`,
    `Macro risk ${input.macroRisk.toFixed(2)} is subtracted as the Phase 3 pressure term.`,
    `Macro Agent ${input.macroGate.regime} applies RiskMultiplier ${input.macroGate.riskMultiplier.toFixed(2)} to pre-multiplier score ${input.preMultiplierScore.toFixed(2)}.`,
    `Macro insight: ${input.macroGate.insight}`,
    input.action === 'BUY'
      ? `Expected score ${input.expectedScore.toFixed(2)} is above 85 and macro risk is below 50; paper BUY action may be simulated with qty ${input.qty}.`
      : input.action === 'WATCH'
        ? `Expected score ${input.expectedScore.toFixed(2)} is in the watch zone; no automatic paper buy action is emitted.`
        : `Expected score ${input.expectedScore.toFixed(2)} is below the acceptance zone or macro pressure is too high; reject this setup.`,
  ]
  if (input.rawAction === 'BUY' && input.action === 'WATCH' && !input.portfolioExposure.allowed) {
    lines.push(input.portfolioExposure.reason)
  }
  return lines
}

function buildTerminalMessage(input: {
  ticker: string
  action: HermesSynthesisAction
  expectedScore: number
  quantScore: number
  mirofishScore: number
  macroRisk: number
  qty: number
  actionPayload?: HermesSynthesizerActionPayload
  portfolioExposure: PortfolioExposureCheckResult
  rawAction: HermesSynthesisAction
  weights: HermesSynthesizerWeights
  weightProfile: HermesDynamicWeightProfile
  macroGate: { regime: string; riskMultiplier: number; insight: string }
  preMultiplierScore: number
}): string {
  const base = [
    `${input.ticker} Phase 5 合成決策：${input.action}`,
    `Regime=${input.weightProfile.label}`,
    `MacroAgent=${input.macroGate.regime}`,
    `RiskMultiplier=${input.macroGate.riskMultiplier.toFixed(2)}`,
    `Weights=${input.weights.w1.toFixed(2)}/${input.weights.w2.toFixed(2)}/${input.weights.w3.toFixed(2)}`,
    `PreScore=${input.preMultiplierScore.toFixed(2)}`,
    `E[S_final]=${input.expectedScore.toFixed(2)}`,
    `S_quant=${input.quantScore.toFixed(2)}`,
    `S_mirofish=${input.mirofishScore.toFixed(2)}`,
    `R_macro=${input.macroRisk.toFixed(2)}`,
  ].join(' / ')

  if (input.rawAction === 'BUY' && input.action === 'WATCH' && !input.portfolioExposure.allowed) {
    return `${base} / ${input.portfolioExposure.reason}`
  }
  if (input.action !== 'BUY' || !input.actionPayload) return base
  return `${base}<ACTION>${JSON.stringify(input.actionPayload)}</ACTION>`
}

function normalizeWeights(weights: Partial<HermesSynthesizerWeights> | undefined, fallback: HermesSynthesizerWeights): HermesSynthesizerWeights {
  return {
    w1: finiteOr(weights?.w1, fallback.w1),
    w2: finiteOr(weights?.w2, fallback.w2),
    w3: finiteOr(weights?.w3, fallback.w3),
  }
}

function normalizeTicker(value: string): string {
  return String(value || '').trim().toUpperCase()
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
