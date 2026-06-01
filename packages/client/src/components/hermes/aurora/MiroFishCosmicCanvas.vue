<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { getQuantLabMiroFishMemoryRecords, type QuantLabMiroFishMemoryRecord, type RunQuantLabMiroFishResult } from '@/api/hermes/quant-lab'

export type MiroFishFocusPath = 'macro' | 'bull' | 'bear' | 'verdict'

type CanvasNodeKind = 'asset' | 'agent' | 'risk' | 'evidence' | 'verdict' | 'regime'

interface CanvasNode {
  id: string
  label: string
  kind: CanvasNodeKind
  x: number
  y: number
  radius: number
  color: string
  summary: string
  metrics: CanvasMetric[]
  path: MiroFishFocusPath[]
}

interface CanvasMetric {
  label: string
  value: string
  tone?: 'neutral' | 'bull' | 'bear' | 'macro' | 'verdict'
}

interface CanvasEdge {
  id: string
  source: string
  target: string
  label: string
  path: MiroFishFocusPath[]
}

interface CanvasPoint {
  x: number
  y: number
}

interface CubicCurve {
  c1: CanvasPoint
  c2: CanvasPoint
}

interface StarParticle {
  x: number
  y: number
  radius: number
  alpha: number
  depth: number
  driftX: number
  driftY: number
  phase: number
  twinkleRate: number
  flarePhase: number
  flareRate: number
  flareStrength: number
  twinkle: boolean
  color: string
}

interface MemoryStar {
  record: QuantLabMiroFishMemoryRecord
  x: number
  y: number
  radius: number
  color: string
  seed: number
}

const props = withDefaults(defineProps<{
  ticker?: string
  topic?: string
  focusPath?: MiroFishFocusPath
  liveResult?: RunQuantLabMiroFishResult | null
  initialMemoryRecordId?: string
  projectId?: string
  graphPath?: string
}>(), {
  ticker: '',
  topic: '',
  focusPath: 'verdict',
  liveResult: null,
  initialMemoryRecordId: '',
  projectId: 'preview-project',
  graphPath: '/process/preview-project',
})

const stageRef = ref<HTMLElement | null>(null)
const starCanvasRef = ref<HTMLCanvasElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const hoveredNode = shallowRef<CanvasNode | null>(null)
const selectedNode = shallowRef<CanvasNode | null>(null)
const memoryRecords = shallowRef<QuantLabMiroFishMemoryRecord[]>([])
const hoveredMemoryRecord = shallowRef<QuantLabMiroFishMemoryRecord | null>(null)
const selectedMemoryRecord = shallowRef<QuantLabMiroFishMemoryRecord | null>(null)
const memoryTooltipPoint = ref<CanvasPoint | null>(null)
const memoryRecordsError = ref('')
const viewport = ref({ width: 960, height: 280 })

let starContext: CanvasRenderingContext2D | null = null
let canvasContext: CanvasRenderingContext2D | null = null
let resizeObserver: ResizeObserver | null = null
let frameId = 0
let lastAnimationTime = 0
let starfield: StarParticle[] = []
let starfieldSignature = ''

const liveTopPick = computed(() => props.liveResult?.topPicks?.[0] || null)
const liveInference = computed(() => props.liveResult?.mirofish?.inference || null)
const liveDebate = computed(() => liveInference.value?.debate || null)
const liveEvidenceArchive = computed(() => props.liveResult?.mirofish?.evidenceArchive || null)
const hasLiveResult = computed(() => Boolean(props.liveResult))
const isUniversalCanvas = computed(() => Boolean(props.topic.trim()))
const targetTicker = computed(() => {
  const topicLabel = props.topic ? 'TOPIC' : ''
  const ticker = liveTopPick.value?.ticker || props.ticker || topicLabel || 'MARKET'
  return String(ticker || 'MARKET').trim().toUpperCase()
})
const subjectLabel = computed(() => cleanText(props.topic || targetTicker.value, 'Market', props.topic ? 76 : 24))
const focusLabels: Record<MiroFishFocusPath, { title: string; detail: string; tone: string }> = {
  macro: {
    title: 'Macro Path',
    detail: 'Regime, volatility, and liquidity pressure feeding the decision.',
    tone: 'macro',
  },
  bull: {
    title: 'Bull Path',
    detail: 'Upside evidence, score momentum, and confirmation flow.',
    tone: 'bull',
  },
  bear: {
    title: 'Bear Path',
    detail: 'Risk gate, drawdown pressure, and invalidation logic.',
    tone: 'bear',
  },
  verdict: {
    title: 'Synthesizer Path',
    detail: 'Macro, Bull, and Bear arguments converge into the final action.',
    tone: 'verdict',
  },
}

const activeFocus = computed(() => focusLabels[props.focusPath])

const liveDataLabel = computed(() => {
  if (!props.liveResult) return 'Awaiting live debate'
  const generatedAt = props.liveResult.generatedAt ? formatClock(props.liveResult.generatedAt) : 'live'
  if (isUniversalCanvas.value) return `Live result · Universal Brain · ${generatedAt}`
  return `Live result · ${targetTicker.value} · ${generatedAt}`
})
const activeMemoryRecord = computed(() => selectedMemoryRecord.value || hoveredMemoryRecord.value)
const memoryConstellationLabel = computed(() => {
  if (memoryRecordsError.value) return 'Memory vault safe fallback'
  const count = memoryRecords.value.length
  return count ? `${count} memory stars hydrated` : 'Memory constellation scanning'
})
const memoryTooltipStyle = computed(() => {
  const point = memoryTooltipPoint.value
  if (!point) return undefined
  const x = Math.min(Math.max(point.x + 18, 16), Math.max(16, viewport.value.width - 300))
  const y = Math.min(Math.max(point.y - 18, 16), Math.max(16, viewport.value.height - 150))
  return {
    left: `${x}px`,
    top: `${y}px`,
  }
})

function cleanText(value: unknown, fallback: string, maxLength = 260): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value)
  const normalized = raw.replace(/\s+/g, ' ').trim() || fallback
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`
}

function numberValue(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function percentLabel(value: unknown, fallback = 'pending'): string {
  const numeric = numberValue(value)
  if (numeric == null) return fallback
  return `${Math.round(numeric * 100)}%`
}

function scoreLabel(value: unknown): string {
  const numeric = numberValue(value)
  if (numeric == null) return 'pending'
  return numeric > 1 ? numeric.toFixed(1) : `${Math.round(numeric * 100)}%`
}

function formatMetric(value: unknown, fallback = 'pending'): string {
  const numeric = numberValue(value)
  if (numeric == null) return cleanText(value, fallback, 36)
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2)
}

function formatClock(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'live'
  return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
}

function probabilityRadius(value: unknown, fallback: number): number {
  const numeric = numberValue(value)
  if (numeric == null) return fallback
  return Math.max(15, Math.min(24, 14 + numeric * 13))
}

function scoreRadius(value: unknown, fallback: number): number {
  const numeric = numberValue(value)
  if (numeric == null) return fallback
  const normalized = numeric > 1 ? numeric / 100 : numeric
  return Math.max(16, Math.min(25, 16 + normalized * 9))
}

function evidenceRadius(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 10
  return Math.max(10, Math.min(15, 10 + Math.log10(count + 1) * 3.5))
}

function orbitPoint(cx: number, cy: number, radiusX: number, radiusY: number, angleDeg: number): CanvasPoint {
  const angle = angleDeg * Math.PI / 180
  return {
    x: cx + Math.cos(angle) * radiusX,
    y: cy + Math.sin(angle) * radiusY,
  }
}

function inferredAction(): string {
  if (isUniversalCanvas.value) {
    const favorable = numberValue(liveDebate.value?.scenarios?.bullish?.probability) || 0
    const pause = numberValue(liveDebate.value?.scenarios?.bearish?.probability) || 0
    if (favorable >= 0.55 && favorable - pause >= 0.1) return 'PILOT'
    if (pause >= 0.46 && pause - favorable >= 0.08) return 'PAUSE'
    return 'HOLD'
  }

  const action = cleanText(liveTopPick.value?.action, '', 18).toUpperCase()
  if (action) return action

  const bullish = numberValue(liveDebate.value?.scenarios?.bullish?.probability) || 0
  const bearish = numberValue(liveDebate.value?.scenarios?.bearish?.probability) || 0
  if (bullish >= 0.58 && bullish - bearish >= 0.12) return 'BUY'
  if (bearish >= 0.5 && bearish - bullish >= 0.1) return 'SELL'
  return 'HOLD'
}

function scenarioLine(label: string, scenario: { probability?: number; reasoning?: string } | undefined): string {
  if (!scenario) return `${label} pending`
  return `${label} ${percentLabel(scenario.probability)}: ${cleanText(scenario.reasoning, 'No scenario reasoning yet.', 92)}`
}

function metric(label: string, value: unknown, tone: CanvasMetric['tone'] = 'neutral'): CanvasMetric {
  return {
    label,
    value: cleanText(value, 'pending', 42),
    tone,
  }
}

function compactMetrics(items: Array<CanvasMetric | null | undefined>): CanvasMetric[] {
  return items.filter((item): item is CanvasMetric => Boolean(item?.value && item.value !== 'pending')).slice(0, 4)
}

function parseJudgeRawSummary(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback

  try {
    const parsed = JSON.parse(raw)
    const scenarios = parsed?.scenarios
    if (scenarios) {
      return cleanText([
        scenarioLine('Bullish', scenarios.bullish),
        scenarioLine('Neutral', scenarios.neutral),
        scenarioLine('Bearish', scenarios.bearish),
      ].join(' · '), fallback)
    }
    return cleanText(parsed?.summary || parsed?.reasoning || parsed?.final || raw, fallback)
  } catch {
    return cleanText(raw, fallback)
  }
}

function synthSummary(
  scenarios: {
    bullish?: { probability?: number; reasoning?: string }
    neutral?: { probability?: number; reasoning?: string }
    bearish?: { probability?: number; reasoning?: string }
  } | undefined,
  judgeRaw: unknown,
  finalAction: string,
): string {
  const fallback = `${finalAction} verdict waits for the live Hermes Synthesizer output.`
  if (scenarios) {
    return cleanText([
      `Final ${finalAction}`,
      scenarioLine('Bullish', scenarios.bullish),
      scenarioLine('Neutral', scenarios.neutral),
      scenarioLine('Bearish', scenarios.bearish),
    ].join(' · '), fallback)
  }
  return parseJudgeRawSummary(judgeRaw, fallback)
}

const graphModel = computed(() => {
  const { width, height } = viewport.value
  const cx = width * 0.5
  const cy = height * 0.5
  const orbitX = Math.max(130, Math.min(width * 0.31, 300))
  const orbitY = Math.max(82, Math.min(height * 0.34, 168))
  const nearOrbitX = Math.max(76, Math.min(width * 0.18, 176))
  const nearOrbitY = Math.max(58, Math.min(height * 0.22, 118))
  const macroPoint = orbitPoint(cx, cy, orbitX, orbitY, -168)
  const bullPoint = orbitPoint(cx, cy, orbitX * 0.78, orbitY, -92)
  const bearPoint = orbitPoint(cx, cy, orbitX, orbitY, -12)
  const regimePoint = orbitPoint(cx, cy, orbitX * 0.92, orbitY * 0.92, 166)
  const evidencePoint = orbitPoint(cx, cy, orbitX * 0.7, orbitY * 1.06, 90)
  const riskPoint = orbitPoint(cx, cy, orbitX * 0.92, orbitY * 0.92, 18)
  const assetPoint = orbitPoint(cx, cy, nearOrbitX, nearOrbitY, 124)
  const ticker = targetTicker.value
  const subject = subjectLabel.value
  const universal = isUniversalCanvas.value
  const topPick = liveTopPick.value
  const inference = liveInference.value
  const debate = liveDebate.value
  const scenarios = debate?.scenarios
  const evidenceArchive = liveEvidenceArchive.value
  const evidenceCount = props.liveResult?.evidenceCount || inference?.evidenceCount || evidenceArchive?.topDegrees?.length || 0
  const finalAction = inferredAction()
  const macroRegime = cleanText(debate?.macro?.Regime, 'Macro Regime', 42)
  const riskMultiplier = formatMetric(debate?.macro?.RiskMultiplier, 'pending')
  const topDegree = evidenceArchive?.topDegrees?.[0]
  const topDegreeLabel = topDegree ? `${topDegree.ticker} degree ${topDegree.degree}` : `${evidenceCount} evidence items`
  const keyRisk = cleanText(debate?.key_risks?.[0] || topPick?.risk, 'Risk gate pending.', 220)
  const rawJudgeSummary = synthSummary(scenarios, debate?.judgeRaw, finalAction)
  const judgeSummary = universal
    ? cleanText(`Universal Brain topic "${subject}". ${rawJudgeSummary}`, rawJudgeSummary, 320)
    : rawJudgeSummary

  const nodes: CanvasNode[] = [
    {
      id: 'ticker',
      label: universal ? `Topic ${finalAction}` : `${ticker} ${finalAction}`,
      kind: 'asset',
      x: assetPoint.x,
      y: assetPoint.y,
      radius: scoreRadius(topPick?.score, 18),
      color: '#38bdf8',
      summary: universal
        ? cleanText(`Universal Brain topic: ${subject}. Decision state ${finalAction}. ${topPick?.reason || ''}`, `${subject} is the active topic from Aurora OmniBar.`)
        : topPick
        ? cleanText(`${ticker} ${finalAction}. Score ${scoreLabel(topPick.score)}, trend ${formatMetric(topPick.trend)}, price ${formatMetric(topPick.price)}. ${topPick.reason || ''}`, `${ticker} is the live asset from MiroFish.`)
        : `${ticker} is the active asset passed from Aurora OmniBar.`,
      metrics: compactMetrics([
        universal ? metric('Type', 'Topic', 'neutral') : null,
        metric('Action', finalAction, 'verdict'),
        metric('Score', scoreLabel(topPick?.score), 'bull'),
        universal ? metric('Subject', subject, 'neutral') : metric('Trend', formatMetric(topPick?.trend), 'neutral'),
        universal ? null : metric('Price', formatMetric(topPick?.price), 'neutral'),
      ]),
      path: ['bull', 'bear', 'verdict'],
    },
    {
      id: 'macro',
      label: macroRegime,
      kind: 'agent',
      x: macroPoint.x,
      y: macroPoint.y,
      radius: 18,
      color: '#818cf8',
      summary: cleanText(debate?.macro?.MacroInsight, universal ? 'Reads context, constraints, optionality, and reversibility before sizing confidence.' : 'Reads regime, VIX, yields, breadth, and liquidity before sizing risk.'),
      metrics: compactMetrics([
        metric('Regime', macroRegime, 'macro'),
        metric('Risk', `${riskMultiplier}x`, 'macro'),
        metric('Mode', inference?.debate?.mode || props.liveResult?.source, 'neutral'),
      ]),
      path: ['macro', 'verdict'],
    },
    {
      id: 'bull',
      label: `Bull ${percentLabel(scenarios?.bullish?.probability)}`,
      kind: 'agent',
      x: bullPoint.x,
      y: bullPoint.y,
      radius: probabilityRadius(scenarios?.bullish?.probability, 16),
      color: '#34d399',
      summary: cleanText(debate?.bull?.content || scenarios?.bullish?.reasoning || inference?.support?.[0], universal ? 'Looks for leverage, learning value, reversibility, and a useful pilot path.' : 'Looks for upside asymmetry, high score confirmation, and follow-through.'),
      metrics: compactMetrics([
        metric('Prob', percentLabel(scenarios?.bullish?.probability), 'bull'),
        metric('Conf', percentLabel(scenarios?.bullish?.confidence), 'bull'),
        metric('Support', inference?.support?.length || 0, 'neutral'),
      ]),
      path: ['bull', 'verdict'],
    },
    {
      id: 'bear',
      label: `Bear ${percentLabel(scenarios?.bearish?.probability)}`,
      kind: 'agent',
      x: bearPoint.x,
      y: bearPoint.y,
      radius: probabilityRadius(scenarios?.bearish?.probability, 16),
      color: '#fb7185',
      summary: cleanText(debate?.bear?.content || scenarios?.bearish?.reasoning || inference?.oppose?.[0], universal ? 'Challenges the thesis with governance, cost, maintenance, safety, and irreversible commitments.' : 'Challenges the thesis with risk-off pressure, valuation, and invalidation.'),
      metrics: compactMetrics([
        metric('Prob', percentLabel(scenarios?.bearish?.probability), 'bear'),
        metric('Conf', percentLabel(scenarios?.bearish?.confidence), 'bear'),
        metric('Risks', debate?.key_risks?.length || inference?.oppose?.length || 0, 'neutral'),
      ]),
      path: ['bear', 'verdict'],
    },
    {
      id: 'regime',
      label: `${riskMultiplier}x Risk`,
      kind: 'regime',
      x: regimePoint.x,
      y: regimePoint.y,
      radius: 12,
      color: '#60a5fa',
      summary: cleanText(`Regime ${macroRegime}. Risk multiplier ${riskMultiplier}x.`, universal ? 'Contextual risk state used to gate the cognitive decision.' : 'Macro regime state used to gate paper-trading exposure.'),
      metrics: compactMetrics([
        metric('Regime', macroRegime, 'macro'),
        metric('Multiplier', `${riskMultiplier}x`, 'macro'),
      ]),
      path: ['macro', 'verdict'],
    },
    {
      id: 'evidence',
      label: `${evidenceCount} Evidence`,
      kind: 'evidence',
      x: evidencePoint.x,
      y: evidencePoint.y,
      radius: evidenceRadius(evidenceCount),
      color: '#a78bfa',
      summary: cleanText(`Evidence archive hydrated from ${topDegreeLabel}.`, universal ? 'Aggregated topic evidence, debate context, and graph memory.' : 'Aggregated evidence archive, score history, and graph memory context.'),
      metrics: compactMetrics([
        metric('Evidence', evidenceCount, 'neutral'),
        metric('Top Degree', topDegree ? `${topDegree.ticker} ${topDegree.degree}` : 'pending', 'neutral'),
        metric('Graph', evidenceArchive?.graphOk ? 'ok' : 'pending', 'neutral'),
      ]),
      path: ['bull', 'verdict'],
    },
    {
      id: 'risk',
      label: 'Risk Gate',
      kind: 'risk',
      x: riskPoint.x,
      y: riskPoint.y,
      radius: 13,
      color: '#f97316',
      summary: keyRisk,
      metrics: compactMetrics([
        metric(universal ? 'Decision' : 'Gate', topPick?.action || finalAction, 'bear'),
        metric('Risks', debate?.key_risks?.length || 0, 'bear'),
        metric('Risk', topPick?.risk || 'pending', 'bear'),
      ]),
      path: ['bear', 'macro', 'verdict'],
    },
    {
      id: 'synth',
      label: `Synth ${finalAction}`,
      kind: 'verdict',
      x: cx,
      y: cy,
      radius: 32,
      color: '#f8fafc',
      summary: judgeSummary,
      metrics: compactMetrics([
        metric('Action', finalAction, 'verdict'),
        metric('Bull', percentLabel(scenarios?.bullish?.probability), 'bull'),
        metric('Neutral', percentLabel(scenarios?.neutral?.probability), 'macro'),
        metric('Bear', percentLabel(scenarios?.bearish?.probability), 'bear'),
      ]),
      path: ['verdict'],
    },
  ]

  const edges: CanvasEdge[] = [
    { id: 'macro-regime', source: 'macro', target: 'regime', label: 'reads', path: ['macro', 'verdict'] },
    { id: 'regime-synth', source: 'regime', target: 'synth', label: `${riskMultiplier}x risk`, path: ['macro', 'verdict'] },
    { id: 'bull-ticker', source: 'bull', target: 'ticker', label: `${percentLabel(scenarios?.bullish?.confidence)} conf`, path: ['bull', 'verdict'] },
    { id: 'evidence-ticker', source: 'evidence', target: 'ticker', label: `${evidenceCount} signals`, path: ['bull', 'verdict'] },
    { id: 'ticker-synth', source: 'ticker', target: 'synth', label: universal ? 'decision delta' : 'asset delta', path: ['bull', 'bear', 'verdict'] },
    { id: 'risk-bear', source: 'risk', target: 'bear', label: 'constraints', path: ['bear', 'macro', 'verdict'] },
    { id: 'risk-synth', source: 'risk', target: 'synth', label: 'guardrail', path: ['bear', 'macro', 'verdict'] },
    { id: 'macro-synth', source: 'macro', target: 'synth', label: 'macro delta', path: ['macro', 'verdict'] },
    { id: 'bull-synth', source: 'bull', target: 'synth', label: percentLabel(scenarios?.bullish?.probability), path: ['bull', 'verdict'] },
    { id: 'bear-synth', source: 'bear', target: 'synth', label: percentLabel(scenarios?.bearish?.probability), path: ['bear', 'verdict'] },
  ]

  return { nodes, edges, nodeMap: new Map(nodes.map(node => [node.id, node])) }
})

const detailNode = computed(() => selectedNode.value || hoveredNode.value || primaryFocusNode.value)
const primaryFocusNode = computed(() => {
  const focusPrimary: Record<MiroFishFocusPath, string> = {
    macro: 'macro',
    bull: 'bull',
    bear: 'bear',
    verdict: 'synth',
  }
  return graphModel.value.nodeMap.get(focusPrimary[props.focusPath]) || null
})

function isActivePath(path: MiroFishFocusPath[]): boolean {
  return path.includes(props.focusPath)
}

function isActiveEdge(edge: CanvasEdge): boolean {
  if (props.focusPath === 'verdict') {
    return edge.target === 'synth' || edge.id === 'ticker-synth'
  }
  return edge.path.includes(props.focusPath)
}

function seedValue(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 9973
  }
  return hash / 9973
}

function starSeed(index: number, salt: string): number {
  return seedValue(`nebula-star-${index}-${salt}`)
}

function memoryRecordTone(record: QuantLabMiroFishMemoryRecord): string {
  return `${record.finalVerdict} ${record.title} ${record.summary}`.toUpperCase()
}

function memoryRecordColor(record: QuantLabMiroFishMemoryRecord): string {
  const tone = memoryRecordTone(record)
  if (tone.includes('BUY') || tone.includes('BULL')) return '#34d399'
  if (tone.includes('SELL') || tone.includes('BEAR') || tone.includes('RISK')) return '#fb7185'
  if (tone.includes('WATCH')) return '#a78bfa'
  if (tone.includes('HOLD')) return '#60a5fa'
  return '#c4b5fd'
}

const memoryStars = computed<MemoryStar[]>(() => {
  const { width, height } = viewport.value
  const cx = width * 0.5
  const cy = height * 0.5
  const outer = Math.max(120, Math.min(width, height) * 0.48)
  const inner = Math.max(90, Math.min(width, height) * 0.3)

  return memoryRecords.value.map((record, index) => {
    const seed = seedValue(`${record.id}-${record.date}-${index}`)
    const angle = seed * Math.PI * 2 + index * 0.72
    const band = inner + (outer - inner) * seedValue(`${record.id}-orbit`)
    const ellipseX = Math.max(120, Math.min(width * 0.46, band * 1.9))
    const ellipseY = Math.max(72, Math.min(height * 0.44, band))
    const x = Math.min(Math.max(cx + Math.cos(angle) * ellipseX, 28), width - 28)
    const y = Math.min(Math.max(cy + Math.sin(angle) * ellipseY, 28), height - 28)

    return {
      record,
      x,
      y,
      radius: 3 + seedValue(`${record.id}-radius`) * 2,
      color: memoryRecordColor(record),
      seed,
    }
  })
})

function hydrateStarfield(width: number, height: number) {
  const signature = `${Math.round(width)}x${Math.round(height)}`
  if (starfieldSignature === signature && starfield.length) return

  const count = Math.max(200, Math.min(300, Math.round((width * height) / 5200)))
  starfield = Array.from({ length: count }, (_, index) => {
    const depth = 0.35 + starSeed(index, 'depth') * 0.9
    const colorRoll = starSeed(index, 'color')
    const color = colorRoll > 0.78
      ? '191, 219, 254'
      : colorRoll > 0.48
        ? '221, 214, 254'
        : '248, 250, 252'

    return {
      x: starSeed(index, 'x') * width,
      y: starSeed(index, 'y') * height,
      radius: 0.45 + starSeed(index, 'radius') * 1.55,
      alpha: 0.28 + starSeed(index, 'alpha') * 0.58,
      depth,
      driftX: (starSeed(index, 'drift-x') - 0.5) * (0.006 + depth * 0.01),
      driftY: (starSeed(index, 'drift-y') - 0.5) * (0.004 + depth * 0.008),
      phase: starSeed(index, 'phase') * Math.PI * 2,
      twinkleRate: 900 + starSeed(index, 'twinkle-rate') * 4600,
      flarePhase: starSeed(index, 'flare-phase') * Math.PI * 2,
      flareRate: 2600 + starSeed(index, 'flare-rate') * 9200,
      flareStrength: 0.35 + starSeed(index, 'flare-strength') * 0.9,
      twinkle: starSeed(index, 'twinkle') > 0.42,
      color,
    }
  })
  starfieldSignature = signature
}

function wrapCoordinate(value: number, max: number): number {
  if (max <= 0) return value
  return ((value % max) + max) % max
}

function rotateAround(point: CanvasPoint, center: CanvasPoint, angle: number): CanvasPoint {
  const dx = point.x - center.x
  const dy = point.y - center.y
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }
}

function nodePoint(node: CanvasNode, time: number): CanvasPoint {
  const seed = seedValue(node.id)
  const isCenter = node.kind === 'verdict'
  const isEvidence = node.kind === 'evidence' || node.kind === 'risk'
  const amplitude = isCenter ? 1.1 : isEvidence ? 4.8 : 3.2
  const center = { x: viewport.value.width * 0.5, y: viewport.value.height * 0.5 }
  const orbitAngle = time / 128000
  const rotated = isCenter
    ? { x: node.x, y: node.y }
    : rotateAround({ x: node.x, y: node.y }, center, orbitAngle)

  return {
    x: rotated.x + Math.sin(time / 5200 + seed * Math.PI * 2) * amplitude,
    y: rotated.y + Math.cos(time / 6100 + seed * Math.PI * 3) * amplitude * 0.7,
  }
}

function edgeControlPoints(edge: CanvasEdge, source: CanvasPoint, target: CanvasPoint): CubicCurve {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const normalX = -dy / length
  const normalY = dx / length
  const seed = seedValue(edge.id)
  const direction = seed > 0.5 ? 1 : -1
  const subtleCurveness = 0.08 + seed * 0.04
  const organicBend = Math.min(22, Math.max(4, length * subtleCurveness)) * direction
  const centralPull = edge.target === 'synth' ? 0.06 : 0
  const { width, height } = viewport.value
  const clampX = (value: number) => Math.min(Math.max(value, 18), Math.max(18, width - 18))
  const clampY = (value: number) => Math.min(Math.max(value, 18), Math.max(18, height - 18))

  return {
    c1: {
      x: clampX(source.x + dx * (0.3 + centralPull) + normalX * organicBend),
      y: clampY(source.y + dy * 0.3 + normalY * organicBend),
    },
    c2: {
      x: clampX(source.x + dx * (0.7 - centralPull) + normalX * organicBend * 0.72),
      y: clampY(source.y + dy * 0.7 + normalY * organicBend * 0.72),
    },
  }
}

function cubicPoint(source: CanvasPoint, controls: CubicCurve, target: CanvasPoint, t: number): CanvasPoint {
  const inverse = 1 - t
  return {
    x:
      inverse ** 3 * source.x +
      3 * inverse ** 2 * t * controls.c1.x +
      3 * inverse * t ** 2 * controls.c2.x +
      t ** 3 * target.x,
    y:
      inverse ** 3 * source.y +
      3 * inverse ** 2 * t * controls.c1.y +
      3 * inverse * t ** 2 * controls.c2.y +
      t ** 3 * target.y,
  }
}

function drawGhostEdgeTrack(ctx: CanvasRenderingContext2D, source: CanvasPoint, target: CanvasPoint, active: boolean) {
  ctx.globalAlpha = active ? 0.07 : 0.018
  ctx.strokeStyle = active ? 'rgba(226, 232, 240, 0.09)' : 'rgba(226, 232, 240, 0.045)'
  ctx.lineWidth = active ? 0.75 : 0.45
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.beginPath()
  ctx.moveTo(source.x, source.y)
  ctx.lineTo(target.x, target.y)
  ctx.stroke()
}

function edgeConfidence(edge: CanvasEdge): number {
  const scenarios = liveDebate.value?.scenarios
  const topPickScore = numberValue(liveTopPick.value?.score)
  const normalizedTopPickScore = topPickScore == null
    ? null
    : topPickScore > 1
      ? topPickScore / 100
      : topPickScore
  if (edge.path.includes('bull')) {
    return numberValue(scenarios?.bullish?.confidence)
      || numberValue(scenarios?.bullish?.probability)
      || normalizedTopPickScore
      || 0.44
  }
  if (edge.path.includes('bear')) {
    return numberValue(scenarios?.bearish?.confidence)
      || numberValue(scenarios?.bearish?.probability)
      || 0.46
  }
  if (edge.path.includes('macro')) {
    const riskMultiplier = numberValue(liveDebate.value?.macro?.RiskMultiplier)
    return riskMultiplier == null ? 0.42 : Math.max(0.25, Math.min(0.9, riskMultiplier / 3))
  }
  return hasLiveResult.value ? 0.6 : 0.34
}

function edgeFlowColor(edge: CanvasEdge): string {
  if (edge.path.includes('bull')) return '94, 192, 158'
  if (edge.path.includes('bear')) return '214, 113, 126'
  if (edge.path.includes('macro')) return '132, 149, 212'
  return '210, 218, 235'
}

function drawEdgeParticles(
  ctx: CanvasRenderingContext2D,
  edge: CanvasEdge,
  source: CanvasPoint,
  controls: CubicCurve,
  target: CanvasPoint,
  time: number,
) {
  const active = isActiveEdge(edge)
  if (!active && props.focusPath === 'verdict') return

  const confidence = Math.max(0.12, Math.min(1, edgeConfidence(edge)))
  const density = Math.max(1, Math.min(5, Math.round((active ? 2 : 1) + confidence * (active ? 3 : 1))))
  const speed = (active ? 0.00048 : 0.00018) * (0.82 + confidence)
  const seed = seedValue(edge.id)
  const color = edgeFlowColor(edge)

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let index = 0; index < density; index += 1) {
    const t = (time * speed + seed + index / density) % 1
    const trailSteps = active ? 3 : 2
    for (let step = trailSteps - 1; step >= 0; step -= 1) {
      const trailT = Math.max(0, t - step * (active ? 0.016 : 0.01))
      const point = cubicPoint(source, controls, target, trailT)
      const trailStrength = 1 - step / trailSteps
      const alpha = active
        ? (0.1 + confidence * 0.16) * trailStrength
        : (0.05 + confidence * 0.07) * trailStrength
      ctx.globalAlpha = alpha
      ctx.fillStyle = `rgba(${color}, ${active ? 0.52 : 0.24})`
      ctx.shadowColor = `rgba(${color}, ${active ? 0.24 : 0.12})`
      ctx.shadowBlur = active ? 6 : 3
      ctx.beginPath()
      ctx.arc(point.x, point.y, (active ? 1.75 : 1.05) * (0.72 + trailStrength * 0.34), 0, Math.PI * 2)
      ctx.fill()
    }

    if (active && index % 2 === 0) {
      const head = cubicPoint(source, controls, target, t)
      ctx.globalAlpha = 0.035 + confidence * 0.045
      ctx.strokeStyle = `rgba(${color}, 0.2)`
      ctx.lineWidth = 0.65
      ctx.shadowColor = `rgba(${color}, 0.18)`
      ctx.shadowBlur = 4
      ctx.beginPath()
      ctx.arc(head.x, head.y, 4.5 + confidence * 2, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  ctx.restore()
}

function resizeCanvas() {
  const stage = stageRef.value
  const starCanvas = starCanvasRef.value
  const canvas = canvasRef.value
  if (!stage || !starCanvas || !canvas) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, stage.clientWidth)
  const height = Math.max(1, stage.clientHeight)
  viewport.value = { width, height }

  starCanvas.width = Math.round(width * dpr)
  starCanvas.height = Math.round(height * dpr)
  starCanvas.style.width = `${width}px`
  starCanvas.style.height = `${height}px`
  starContext = starCanvas.getContext('2d', { alpha: true })
  starContext?.setTransform(dpr, 0, 0, dpr, 0, 0)
  hydrateStarfield(width, height)

  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvasContext = canvas.getContext('2d', { alpha: true })
  canvasContext?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + safeRadius, y)
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius)
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius)
  ctx.arcTo(x, y + height, x, y, safeRadius)
  ctx.arcTo(x, y, x + width, y, safeRadius)
  ctx.closePath()
}

function drawGlassLabel(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, active: boolean, selected = false) {
  ctx.save()
  ctx.font = `${selected ? 800 : 700} 11px Inter, system-ui, sans-serif`
  const labelWidth = Math.min(ctx.measureText(label).width + 22, 200)
  const labelHeight = 25
  const labelX = Math.min(Math.max(x - labelWidth / 2, 12), viewport.value.width - labelWidth - 12)
  const labelY = y
  ctx.shadowColor = active ? 'rgba(255, 255, 255, 0.22)' : 'rgba(15, 23, 42, 0.18)'
  ctx.shadowBlur = active ? 18 : 8
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.strokeStyle = selected
    ? 'rgba(255, 255, 255, 0.42)'
    : active
      ? 'rgba(255, 255, 255, 0.24)'
      : 'rgba(255, 255, 255, 0.15)'
  ctx.lineWidth = selected ? 1.4 : 1
  drawRoundedRect(ctx, labelX, labelY, labelWidth, labelHeight, 999)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = active ? '#ffffff' : 'rgba(226, 232, 240, 0.78)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, labelX + labelWidth / 2, labelY + labelHeight / 2)
  ctx.restore()
}

function hexToRgb(hexColor: string): { r: number; g: number; b: number } {
  const normalized = hexColor.replace('#', '').trim()
  const fallback = { r: 248, g: 250, b: 252 }
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return fallback

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  }
}

function rgba(hexColor: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hexColor)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function drawNodeGlassOrb(
  ctx: CanvasRenderingContext2D,
  node: CanvasNode,
  point: CanvasPoint,
  radius: number,
  active: boolean,
  selected: boolean,
  pulse: number,
) {
  const isVerdict = node.kind === 'verdict'
  const ringColor = isVerdict ? '#c7d2fe' : node.color
  const ringAlpha = selected ? 0.34 : active ? 0.2 : 0.1
  const ghostPulse = active ? Math.max(0, pulse) * 0.08 : 0

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = selected ? 0.46 : active ? 0.3 : 0.18
  const bubble = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius)
  bubble.addColorStop(0, 'rgba(255, 255, 255, 0)')
  bubble.addColorStop(0.56, isVerdict ? 'rgba(199, 210, 254, 0.018)' : rgba(ringColor, 0.012))
  bubble.addColorStop(0.86, isVerdict ? 'rgba(199, 210, 254, 0.045)' : rgba(ringColor, 0.035))
  bubble.addColorStop(1, isVerdict ? 'rgba(226, 232, 240, 0.058)' : rgba(ringColor, 0.052))
  ctx.fillStyle = bubble
  ctx.beginPath()
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = selected ? 0.56 : active ? 0.34 : 0.18
  ctx.shadowColor = rgba(ringColor, isVerdict ? 0.14 : 0.1)
  ctx.shadowBlur = selected ? 7 : active ? 5 + ghostPulse : 3
  ctx.strokeStyle = rgba(ringColor, ringAlpha)
  ctx.lineWidth = selected ? 1.5 : active ? 1.1 : 0.9
  ctx.beginPath()
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  if (selected) {
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 0.22
    ctx.shadowColor = rgba(ringColor, 0.14)
    ctx.shadowBlur = 5
    ctx.strokeStyle = rgba(ringColor, 0.12)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(point.x, point.y, radius + 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}

function memoryStarPoint(star: MemoryStar, time: number): CanvasPoint {
  const isSelected = selectedMemoryRecord.value?.id === star.record.id
  if (isSelected) {
    return {
      x: viewport.value.width * 0.5 + Math.sin(time / 1200 + star.seed) * 1.8,
      y: viewport.value.height * 0.5 + Math.cos(time / 1400 + star.seed) * 1.4,
    }
  }
  return {
    x: star.x + Math.sin(time / 5200 + star.seed * 12) * 3.8,
    y: star.y + Math.cos(time / 6100 + star.seed * 9) * 2.8,
  }
}

function drawMemoryStar(ctx: CanvasRenderingContext2D, star: MemoryStar, time: number) {
  const hovered = hoveredMemoryRecord.value?.id === star.record.id
  const selected = selectedMemoryRecord.value?.id === star.record.id
  const point = memoryStarPoint(star, time)
  const breathing = 0.5 + Math.sin(time / 1280 + star.seed * Math.PI * 2) * 0.5
  const radius = selected ? 11 + breathing * 1.2 : hovered ? star.radius + 3 : star.radius
  const rgb = hexToRgb(star.color)

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = selected ? 0.34 : hovered ? 0.24 : 0.1
  ctx.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${selected ? 0.16 : hovered ? 0.12 : 0.06})`
  ctx.shadowBlur = selected ? 7 : hovered ? 5 : 2
  ctx.fillStyle = 'rgba(0, 0, 0, 0)'
  ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${selected ? 0.34 : hovered ? 0.26 : 0.13})`
  ctx.lineWidth = selected ? 1.35 : hovered ? 1.1 : 0.85
  ctx.beginPath()
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  if (!hovered && !selected) return

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = selected ? 0.16 : 0.1
  ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${selected ? 0.24 : 0.16})`
  ctx.lineWidth = 0.75
  ctx.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${selected ? 0.12 : 0.08})`
  ctx.shadowBlur = selected ? 6 : 4
  ctx.beginPath()
  ctx.arc(point.x, point.y, radius + (selected ? 5 : 4), 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  drawGlassLabel(ctx, selected ? 'Rehydrated Memory' : 'Memory', point.x, point.y + radius + 10, true, selected)
}

function drawMemoryConstellation(ctx: CanvasRenderingContext2D, time: number) {
  const activeId = selectedMemoryRecord.value?.id
  for (const star of memoryStars.value) {
    if (activeId && star.record.id === activeId) continue
    drawMemoryStar(ctx, star, time)
  }
}

function drawMemoryRehydration(ctx: CanvasRenderingContext2D, record: QuantLabMiroFishMemoryRecord, time: number) {
  const { width, height } = viewport.value
  const center = { x: width * 0.5, y: height * 0.5 }
  const color = memoryRecordColor(record)
  const rgb = hexToRgb(color)
  const pulse = 0.5 + Math.sin(time / 700) * 0.5
  const orbit = Math.max(74, Math.min(width, height) * 0.16)
  const nodes = [
    { label: 'Question', value: record.question, angle: -150, color: '#a78bfa' },
    { label: 'Verdict', value: record.finalVerdict, angle: -20, color },
    { label: 'Date', value: record.date.slice(0, 10), angle: 96, color: '#60a5fa' },
  ]

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  for (const item of nodes) {
    const angle = item.angle * Math.PI / 180
    const point = {
      x: center.x + Math.cos(angle) * orbit * 1.45,
      y: center.y + Math.sin(angle) * orbit,
    }
    const itemRgb = hexToRgb(item.color)
    ctx.globalAlpha = 0.1
    ctx.strokeStyle = `rgba(${itemRgb.r}, ${itemRgb.g}, ${itemRgb.b}, 0.28)`
    ctx.lineWidth = 0.8
    ctx.shadowColor = `rgba(${itemRgb.r}, ${itemRgb.g}, ${itemRgb.b}, 0.12)`
    ctx.shadowBlur = 4
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
    ctx.lineTo(center.x, center.y)
    ctx.stroke()

    const nodeRadius = 8 + pulse * 1.4
    ctx.globalAlpha = 0.34
    ctx.fillStyle = 'rgba(0, 0, 0, 0)'
    ctx.strokeStyle = `rgba(${itemRgb.r}, ${itemRgb.g}, ${itemRgb.b}, 0.34)`
    ctx.lineWidth = 1
    ctx.shadowColor = `rgba(${itemRgb.r}, ${itemRgb.g}, ${itemRgb.b}, 0.14)`
    ctx.shadowBlur = 6
    ctx.beginPath()
    ctx.arc(point.x, point.y, nodeRadius, 0, Math.PI * 2)
    ctx.stroke()
    drawGlassLabel(ctx, item.label, point.x, point.y + 16, true)
  }

  const coreRadius = 24 + pulse * 5
  ctx.globalAlpha = 0.5
  ctx.fillStyle = 'rgba(0, 0, 0, 0)'
  ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.38)`
  ctx.lineWidth = 1.2
  ctx.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`
  ctx.shadowBlur = 9 + pulse * 2
  ctx.beginPath()
  ctx.arc(center.x, center.y, coreRadius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  drawGlassLabel(ctx, record.title, center.x, center.y + coreRadius + 14, true, true)
}

function drawStarfield(time = performance.now()) {
  const canvas = starCanvasRef.value
  const ctx = starContext
  if (!canvas || !ctx) return

  const { width, height } = viewport.value
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.restore()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalCompositeOperation = 'lighter'

  for (const star of starfield) {
    const driftX = time * star.driftX
    const driftY = time * star.driftY
    const basePoint = {
      x: wrapCoordinate(star.x + driftX + 24, width + 48) - 24,
      y: wrapCoordinate(star.y + driftY + 24, height + 48) - 24,
    }
    const point = rotateAround(
      basePoint,
      { x: width * 0.5, y: height * 0.5 },
      time / (240000 - star.depth * 42000),
    )
    const shimmer = star.twinkle
      ? 0.58
        + Math.sin(time / star.twinkleRate + star.phase) * 0.16
        + Math.sin(time / (star.twinkleRate * 1.73) + star.phase * 2.3) * 0.12
        + Math.sin(time / (star.twinkleRate * 0.41) + star.flarePhase) * 0.06
      : 0.62
    const flareWave = star.twinkle
      ? Math.max(0, Math.sin(time / star.flareRate + star.flarePhase))
      : 0
    const flareGate = star.twinkle
      ? Math.max(0, Math.sin(time / (star.flareRate * 0.37) + star.phase))
      : 0
    const flare = Math.pow(flareWave * flareGate, 10) * star.flareStrength
    const alpha = Math.max(0.08, Math.min(0.95, star.alpha * shimmer * 0.72 + flare * 0.52))
    const starRadius = star.radius * star.depth * (1 + flare * 1.5)

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = `rgba(${star.color}, ${0.42 + star.depth * 0.16})`
    ctx.shadowColor = `rgba(${star.color}, ${0.14 + star.depth * 0.1 + flare * 0.42})`
    ctx.shadowBlur = 2.5 + star.radius * 2.4 + flare * 18
    ctx.beginPath()
    ctx.arc(point.x, point.y, starRadius, 0, Math.PI * 2)
    ctx.fill()

    if (flare > 0.08) {
      const flareSize = 4 + flare * 16
      ctx.globalAlpha = Math.min(0.38, flare * 0.5)
      ctx.strokeStyle = `rgba(${star.color}, ${0.18 + flare * 0.34})`
      ctx.lineWidth = 0.7
      ctx.shadowBlur = 10 + flare * 18
      ctx.beginPath()
      ctx.moveTo(point.x - flareSize, point.y)
      ctx.lineTo(point.x + flareSize, point.y)
      ctx.moveTo(point.x, point.y - flareSize)
      ctx.lineTo(point.x, point.y + flareSize)
      ctx.stroke()
    }
    ctx.restore()
  }

  ctx.globalCompositeOperation = 'source-over'
}

function drawCanvas(time = performance.now()) {
  const canvas = canvasRef.value
  const ctx = canvasContext
  if (!canvas || !ctx) return

  lastAnimationTime = time
  const { width } = viewport.value
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.restore()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'

  const pulse = 0.45 + Math.sin(time / 420) * 0.22
  const { edges, nodes, nodeMap } = graphModel.value
  drawMemoryConstellation(ctx, time)

  if (selectedMemoryRecord.value) {
    drawMemoryRehydration(ctx, selectedMemoryRecord.value, time)
    return
  }

  for (const edge of edges) {
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (!source || !target) continue
    const sourcePoint = nodePoint(source, time)
    const targetPoint = nodePoint(target, time)
    const curve = edgeControlPoints(edge, sourcePoint, targetPoint)
    const labelPoint = cubicPoint(sourcePoint, curve, targetPoint, 0.5)
    const active = isActiveEdge(edge)
    ctx.save()
    drawGhostEdgeTrack(ctx, sourcePoint, targetPoint, active)
    drawEdgeParticles(ctx, edge, sourcePoint, curve, targetPoint, time)
    if (active && props.focusPath !== 'verdict' && width > 680) {
      drawGlassLabel(ctx, edge.label, labelPoint.x, labelPoint.y - 12, active)
    }
    ctx.restore()
  }

  for (const node of nodes) {
    const active = isActivePath(node.path)
    const hovered = hoveredNode.value?.id === node.id
    const selected = selectedNode.value?.id === node.id
    const point = nodePoint(node, time)
    const seed = seedValue(node.id)
    const isVerdict = node.kind === 'verdict'
    const breath = Math.sin(time / (isVerdict ? 560 : active ? 760 : 1200) + seed * Math.PI * 2)
    const scale = (selected ? 1.18 : hovered ? 1.12 : 1) * (active ? 1 + breath * (isVerdict ? 0.075 : 0.045) : 1 + breath * 0.014)
    ctx.save()
    ctx.globalAlpha = active ? 0.58 : 0.24
    ctx.shadowColor = node.color
    ctx.shadowBlur = active ? 8 + pulse * 2 : 3
    drawNodeGlassOrb(ctx, node, point, node.radius * scale, active || isVerdict, selected, pulse)
    ctx.restore()

    if (hovered) {
      drawGlassLabel(ctx, node.label, point.x, point.y + node.radius + 12, true, false)
    }
  }
}

function animationLoop(time: number) {
  drawStarfield(time)
  drawCanvas(time)
  frameId = requestAnimationFrame(animationLoop)
}

function memoryAtPoint(x: number, y: number): QuantLabMiroFishMemoryRecord | null {
  const time = lastAnimationTime || performance.now()
  for (let index = memoryStars.value.length - 1; index >= 0; index -= 1) {
    const star = memoryStars.value[index]
    const point = memoryStarPoint(star, time)
    const dx = point.x - x
    const dy = point.y - y
    const hitRadius = selectedMemoryRecord.value?.id === star.record.id ? 24 : Math.max(12, star.radius + 8)
    if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) return star.record
  }
  return null
}

function nodeAtPoint(x: number, y: number): CanvasNode | null {
  for (let index = graphModel.value.nodes.length - 1; index >= 0; index -= 1) {
    const node = graphModel.value.nodes[index]
    const point = nodePoint(node, lastAnimationTime || performance.now())
    const dx = point.x - x
    const dy = point.y - y
    if (Math.sqrt(dx * dx + dy * dy) <= node.radius + 10) return node
  }
  return null
}

function eventPoint(event: PointerEvent): { x: number; y: number } {
  const rect = canvasRef.value?.getBoundingClientRect()
  return {
    x: event.clientX - (rect?.left || 0),
    y: event.clientY - (rect?.top || 0),
  }
}

function handlePointerMove(event: PointerEvent) {
  const point = eventPoint(event)
  const memory = memoryAtPoint(point.x, point.y)
  hoveredMemoryRecord.value = memory
  memoryTooltipPoint.value = memory ? point : null
  hoveredNode.value = memory || selectedMemoryRecord.value ? null : nodeAtPoint(point.x, point.y)
  if (canvasRef.value) canvasRef.value.style.cursor = memory || hoveredNode.value ? 'pointer' : 'default'
}

function handlePointerLeave() {
  hoveredNode.value = null
  hoveredMemoryRecord.value = null
  memoryTooltipPoint.value = null
}

function handleClick(event: PointerEvent) {
  const point = eventPoint(event)
  const memory = memoryAtPoint(point.x, point.y)
  if (memory) {
    selectedMemoryRecord.value = selectedMemoryRecord.value?.id === memory.id ? null : memory
    selectedNode.value = null
    return
  }
  if (selectedMemoryRecord.value) {
    selectedMemoryRecord.value = null
    selectedNode.value = null
    return
  }
  selectedNode.value = nodeAtPoint(point.x, point.y)
}

function syncInitialMemoryRecord() {
  const key = props.initialMemoryRecordId.trim()
  if (!key) return
  const record = memoryRecords.value.find(item =>
    item.id === key ||
    item.relativePath === key ||
    item.path === key ||
    item.fileName === key,
  )
  if (!record) return
  selectedMemoryRecord.value = record
  hoveredMemoryRecord.value = null
  selectedNode.value = null
}

async function loadMemoryConstellation() {
  try {
    memoryRecordsError.value = ''
    const result = await getQuantLabMiroFishMemoryRecords(96)
    memoryRecords.value = Array.isArray(result.records) ? result.records : []
    syncInitialMemoryRecord()
  } catch (err) {
    memoryRecords.value = []
    memoryRecordsError.value = err instanceof Error ? err.message : 'Memory constellation unavailable'
  }
}

watch(() => props.focusPath, () => {
  selectedNode.value = null
})

watch(() => props.initialMemoryRecordId, () => {
  syncInitialMemoryRecord()
})

watch(graphModel, () => {
  const selectedId = selectedNode.value?.id
  selectedNode.value = selectedId
    ? graphModel.value.nodeMap.get(selectedId) || null
    : null
})

onMounted(() => {
  resizeCanvas()
  selectedNode.value = null
  void loadMemoryConstellation()
  resizeObserver = new ResizeObserver(resizeCanvas)
  if (stageRef.value) resizeObserver.observe(stageRef.value)
  window.addEventListener('resize', resizeCanvas)
  frameId = requestAnimationFrame(animationLoop)
})

onUnmounted(() => {
  if (frameId) cancelAnimationFrame(frameId)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', resizeCanvas)
})
</script>

<template>
  <section ref="stageRef" class="mirofish-cosmic-canvas" aria-label="MiroFish native cosmic canvas">
    <canvas
      ref="starCanvasRef"
      class="cosmic-starfield"
      aria-hidden="true"
    ></canvas>

    <canvas
      ref="canvasRef"
      class="cosmic-canvas"
      @pointermove="handlePointerMove"
      @pointerleave="handlePointerLeave"
      @click="handleClick"
    ></canvas>

    <div class="cosmic-data-pill" :class="{ live: hasLiveResult }">
      <span></span>
      <strong>{{ liveDataLabel }}</strong>
    </div>

    <div class="memory-constellation-pill" :class="{ live: memoryRecords.length > 0, warn: memoryRecordsError }">
      <span></span>
      <strong>{{ memoryConstellationLabel }}</strong>
    </div>

    <div class="cosmic-sync-card" :class="activeFocus.tone">
      <p>Shared Inference Focus</p>
      <h3>{{ activeFocus.title }}</h3>
      <span>{{ activeFocus.detail }}</span>
    </div>

    <aside
      v-if="hoveredMemoryRecord && !selectedMemoryRecord"
      class="memory-tooltip-card"
      :style="memoryTooltipStyle"
      aria-label="MiroFish memory star tooltip"
    >
      <p>Memory Star</p>
      <h3>{{ hoveredMemoryRecord.title }}</h3>
      <span>{{ hoveredMemoryRecord.finalVerdict }}</span>
      <small>{{ hoveredMemoryRecord.date.slice(0, 10) }} · {{ hoveredMemoryRecord.source }}</small>
    </aside>

    <aside v-if="activeMemoryRecord" class="cosmic-detail-card memory">
      <p>{{ selectedMemoryRecord ? 'rehydrated memory' : 'memory star' }}</p>
      <h3>{{ activeMemoryRecord.title }}</h3>
      <span>{{ activeMemoryRecord.question }}</span>
      <div class="cosmic-detail-metrics memory-metrics">
        <article class="verdict">
          <small>Verdict</small>
          <strong>{{ activeMemoryRecord.finalVerdict }}</strong>
        </article>
        <article>
          <small>Date</small>
          <strong>{{ activeMemoryRecord.date.slice(0, 10) }}</strong>
        </article>
      </div>
      <small>{{ activeMemoryRecord.relativePath }}</small>
    </aside>

    <aside v-else-if="detailNode" class="cosmic-detail-card" :class="detailNode.kind">
      <p>{{ detailNode.kind }}</p>
      <h3>{{ detailNode.label }}</h3>
      <span>{{ detailNode.summary }}</span>
      <div v-if="detailNode.metrics.length" class="cosmic-detail-metrics">
        <article
          v-for="item in detailNode.metrics"
          :key="`${detailNode.id}-${item.label}`"
          :class="item.tone"
        >
          <small>{{ item.label }}</small>
          <strong>{{ item.value }}</strong>
        </article>
      </div>
      <small>{{ projectId }} · {{ graphPath }}</small>
    </aside>
  </section>
</template>

<style scoped lang="scss">
.mirofish-cosmic-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 280px;
  overflow: hidden;
  isolation: isolate;
  background:
    radial-gradient(circle at 48% 50%, rgba(79, 70, 229, 0.08), transparent 48%),
    radial-gradient(circle at 16% 24%, rgba(74, 21, 75, 0.34), transparent 46%),
    radial-gradient(circle at 82% 72%, rgba(15, 23, 42, 0.9), transparent 48%),
    conic-gradient(from 215deg at 46% 46%, #0b0b1a 0deg, #2b0f4c 96deg, #4a154b 156deg, #111827 238deg, #020617 312deg, #0b0b1a 360deg);
}

.mirofish-cosmic-canvas::before {
  position: absolute;
  inset: -95%;
  z-index: 0;
  pointer-events: none;
  content: "";
  background:
    radial-gradient(circle at 50% 48%, rgba(79, 70, 229, 0.14), transparent 40%),
    radial-gradient(circle at 18% 18%, rgba(14, 165, 233, 0.1), transparent 34%),
    radial-gradient(circle at 84% 76%, rgba(74, 21, 75, 0.3), transparent 42%),
    conic-gradient(from 215deg at 46% 46%, #0b0b1a 0deg, #2b0f4c 96deg, #4a154b 156deg, #111827 238deg, #020617 312deg, #0b0b1a 360deg);
  opacity: 0.88;
  transform-origin: center;
  animation: cosmic-nebula-turn 168s linear infinite;
  will-change: transform;
}

.mirofish-cosmic-canvas::after {
  display: none;
  content: "";
}

.cosmic-starfield {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  pointer-events: none;
  transform: translate3d(var(--star-parallax-x, 0), var(--star-parallax-y, 0), 0);
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.cosmic-canvas {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
}

@keyframes cosmic-nebula-turn {
  0% {
    transform: rotate(0deg) scale(1.22);
  }

  50% {
    transform: rotate(180deg) scale(1.28);
  }

  100% {
    transform: rotate(360deg) scale(1.22);
  }
}

.cosmic-data-pill {
  position: absolute;
  left: 16px;
  top: 16px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(320px, calc(100% - 32px));
  padding: 9px 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.42);
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.2);
  color: rgba(226, 232, 240, 0.72);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.cosmic-data-pill span {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.72);
  box-shadow: 0 0 14px rgba(148, 163, 184, 0.4);
}

.cosmic-data-pill.live {
  border-color: rgba(52, 211, 153, 0.28);
  color: rgba(236, 253, 245, 0.92);
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.22), inset 0 0 24px rgba(16, 185, 129, 0.09);
}

.cosmic-data-pill.live span {
  background: #34d399;
  box-shadow: 0 0 18px rgba(52, 211, 153, 0.9);
}

.cosmic-data-pill strong {
  overflow: hidden;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-constellation-pill {
  position: absolute;
  left: 16px;
  top: 58px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(330px, calc(100% - 32px));
  padding: 9px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.34);
  box-shadow: 0 16px 44px rgba(2, 6, 23, 0.18), inset 0 0 18px rgba(167, 139, 250, 0.06);
  color: rgba(226, 232, 240, 0.68);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.memory-constellation-pill span {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgba(167, 139, 250, 0.68);
  box-shadow: 0 0 16px rgba(167, 139, 250, 0.44);
}

.memory-constellation-pill.live {
  border-color: rgba(167, 139, 250, 0.28);
  color: rgba(245, 243, 255, 0.9);
}

.memory-constellation-pill.warn {
  border-color: rgba(251, 113, 133, 0.28);
}

.memory-constellation-pill.warn span {
  background: #fb7185;
  box-shadow: 0 0 16px rgba(251, 113, 133, 0.54);
}

.memory-constellation-pill strong {
  overflow: hidden;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cosmic-sync-card,
.cosmic-detail-card {
  position: absolute;
  z-index: 3;
  display: grid;
  gap: 6px;
  max-width: min(340px, calc(100% - 32px));
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(15, 23, 42, 0.46);
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.26);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.cosmic-sync-card {
  top: 16px;
  right: 16px;
  padding: 13px 15px;
  border-radius: 20px;
}

.cosmic-detail-card {
  right: 16px;
  bottom: 16px;
  padding: 14px 16px;
  border-radius: 22px;
}

.memory-tooltip-card {
  position: absolute;
  z-index: 4;
  display: grid;
  gap: 5px;
  width: min(280px, calc(100% - 32px));
  padding: 12px 14px;
  border: 1px solid rgba(196, 181, 253, 0.22);
  border-radius: 18px;
  background: rgba(15, 23, 42, 0.5);
  box-shadow: 0 18px 48px rgba(2, 6, 23, 0.3), inset 0 0 26px rgba(167, 139, 250, 0.08);
  color: rgba(248, 250, 252, 0.92);
  pointer-events: none;
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.memory-tooltip-card p,
.memory-tooltip-card h3,
.memory-tooltip-card span,
.memory-tooltip-card small {
  margin: 0;
}

.memory-tooltip-card p {
  color: rgba(196, 181, 253, 0.82);
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
}

.memory-tooltip-card h3 {
  color: #fff;
  font-size: 14px;
  font-weight: 920;
  letter-spacing: 0;
  line-height: 1.15;
}

.memory-tooltip-card span,
.memory-tooltip-card small {
  color: rgba(226, 232, 240, 0.72);
  font-size: 11px;
  font-weight: 750;
  line-height: 1.3;
}

.cosmic-sync-card.macro,
.cosmic-detail-card.agent {
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.26), inset 0 0 34px rgba(99, 102, 241, 0.1);
}

.cosmic-sync-card.bull {
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.26), inset 0 0 34px rgba(16, 185, 129, 0.12);
}

.cosmic-sync-card.bear,
.cosmic-detail-card.risk {
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.26), inset 0 0 34px rgba(244, 63, 94, 0.12);
}

.cosmic-sync-card.verdict,
.cosmic-detail-card.verdict {
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.26), inset 0 0 38px rgba(248, 250, 252, 0.1);
}

.cosmic-detail-card.memory {
  border-color: rgba(196, 181, 253, 0.22);
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.28), inset 0 0 38px rgba(167, 139, 250, 0.1);
}

.cosmic-sync-card p,
.cosmic-sync-card h3,
.cosmic-sync-card span,
.cosmic-detail-card p,
.cosmic-detail-card h3,
.cosmic-detail-card span,
.cosmic-detail-card small,
.cosmic-detail-metrics small,
.cosmic-detail-metrics strong {
  margin: 0;
}

.cosmic-sync-card p,
.cosmic-detail-card p,
.cosmic-detail-card > small,
.cosmic-detail-metrics small {
  color: rgba(191, 219, 254, 0.76);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
  line-height: 1.1;
  text-transform: uppercase;
}

.cosmic-sync-card h3,
.cosmic-detail-card h3 {
  color: #fff;
  font-size: 17px;
  font-weight: 930;
  letter-spacing: 0;
  line-height: 1.1;
}

.cosmic-sync-card span,
.cosmic-detail-card span {
  color: rgba(226, 232, 240, 0.72);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
}

.cosmic-detail-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  margin-top: 4px;
}

.cosmic-detail-metrics article {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 8px 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.055);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.cosmic-detail-metrics article.bull {
  border-color: rgba(52, 211, 153, 0.22);
  box-shadow: inset 0 0 18px rgba(16, 185, 129, 0.08);
}

.cosmic-detail-metrics article.bear {
  border-color: rgba(251, 113, 133, 0.22);
  box-shadow: inset 0 0 18px rgba(244, 63, 94, 0.08);
}

.cosmic-detail-metrics article.macro {
  border-color: rgba(129, 140, 248, 0.24);
  box-shadow: inset 0 0 18px rgba(99, 102, 241, 0.08);
}

.cosmic-detail-metrics article.verdict {
  border-color: rgba(248, 250, 252, 0.22);
  box-shadow: inset 0 0 18px rgba(248, 250, 252, 0.06);
}

.memory-metrics article {
  min-width: 0;
}

.cosmic-detail-metrics small {
  overflow: hidden;
  color: rgba(191, 219, 254, 0.58);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cosmic-detail-metrics strong {
  overflow: hidden;
  color: #f8fafc;
  font-size: 12px;
  font-weight: 930;
  letter-spacing: 0;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cosmic-detail-card > small {
  overflow: hidden;
  color: rgba(203, 213, 225, 0.48);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 820px) {
  .cosmic-sync-card {
    left: 16px;
    top: 76px;
  }

  .cosmic-detail-card {
    left: 16px;
    right: 16px;
  }
}
</style>
