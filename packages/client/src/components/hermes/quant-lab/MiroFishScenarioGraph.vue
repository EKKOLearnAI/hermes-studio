<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type {
  QuantLabDecision,
  QuantLabMarketPulseItem,
  QuantLabMiroFishGraphSummary,
  QuantLabMiroFishSeed,
  QuantLabPaperGuardrails,
  QuantLabTopPick,
} from '@/api/hermes/quant-lab'
import { useTerminalState } from '@/composables/useTerminalState'

type GraphNodeType = 'symbol' | 'risk' | 'flow' | 'signal' | 'macro' | 'decision' | 'seed'
type GraphStatus = 'idle' | 'analyzing' | 'triggered' | 'risk'

interface GraphJournalEntry {
  time: string
  ticker: string
  action: string
  note: string
}

interface GraphPosition {
  ticker: string
  shares: number
  avgCost: number
  lastPrice: number
  stop: string
}

interface GraphNode {
  id: string
  label: string
  type: GraphNodeType
  status: GraphStatus
  size: number
  details: Record<string, unknown>
  x: number
  y: number
  vx: number
  vy: number
  anchorX?: number
  anchorY?: number
  createdAt: number
}

interface GraphLink {
  id: string
  source: string
  target: string
  strength: number
  active: boolean
  label: string
}

const props = defineProps<{
  topPicks: QuantLabTopPick[]
  marketPulse: QuantLabMarketPulseItem[]
  decision: QuantLabDecision
  guardrails: QuantLabPaperGuardrails | null
  latestSeed: QuantLabMiroFishSeed | null
  graphSummary: QuantLabMiroFishGraphSummary | null
  journal: GraphJournalEntry[]
  positions: GraphPosition[]
}>()

const emit = defineEmits<{
  nodeClick: [node: { id: string; label: string; type: GraphNodeType; ticker: string | null; details: Record<string, unknown> }]
}>()

const { activeTicker, focusMode } = useTerminalState()
const stageRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const graphNodes = shallowRef<GraphNode[]>([])
const graphLinks = shallowRef<GraphLink[]>([])
const stageWidth = ref(860)
const stageHeight = ref(390)
const hoverNode = ref<GraphNode | null>(null)
const tooltipPosition = ref({ x: 0, y: 0 })
const supportsCanvas = ref(true)
const animationNow = ref(0)

let frameId = 0
let resizeObserver: ResizeObserver | null = null

const typeColors: Record<GraphNodeType, string> = {
  symbol: '#23f7ff',
  risk: '#ff365e',
  flow: '#00ff9d',
  signal: '#ffe45c',
  macro: '#00e5ff',
  decision: '#ff4fd8',
  seed: '#4da3ff',
}

const macroRiskMultiplier = computed(() => {
  const value = props.decision.riskMultiplier
  return typeof value === 'number' && Number.isFinite(value) ? value : 1
})
const macroRiskOffAlert = computed(() => macroRiskMultiplier.value < 0.5)
const macroRegimeLabel = computed(() => props.decision.macroRegime || props.decision.weightRegimeLabel || getPulseValue('Regime') || 'Unknown')
const macroInsightLine = computed(() => props.decision.macroInsight || 'Macro Agent 尚未產生獨立判斷，暫以市場狀態與 VIX/10Y 作為代理。')

const legendItems = computed(() => [
  { type: 'symbol', label: '標的', color: typeColors.symbol },
  { type: 'risk', label: '風險', color: typeColors.risk },
  { type: 'flow', label: '資金流', color: typeColors.flow },
  { type: 'signal', label: '訊號', color: typeColors.signal },
  { type: 'macro', label: '宏觀', color: typeColors.macro },
  { type: 'decision', label: '決策', color: typeColors.decision },
])

function displayGraphType(type: GraphNodeType): string {
  const labels: Record<GraphNodeType, string> = {
    symbol: '標的',
    risk: '風險',
    flow: '資金流',
    signal: '訊號',
    macro: '宏觀',
    decision: '決策',
    seed: '種子',
  }
  return labels[type]
}

function displayGraphStatus(status: GraphStatus): string {
  const labels: Record<GraphStatus, string> = {
    idle: '待命',
    analyzing: '分析中',
    triggered: '已觸發',
    risk: '風險',
  }
  return labels[status]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getPulseValue(label: string): string {
  return props.marketPulse.find(item => item.label === label)?.value || 'n/a'
}

function toneStatus(pick: QuantLabTopPick): GraphStatus {
  if (pick.action === 'BUY') return 'triggered'
  if (pick.risk === 'H') return 'risk'
  if (pick.action === 'WATCH' || pick.score >= 86) return 'analyzing'
  return 'idle'
}

function scoreStrength(score: number): number {
  return clamp((score - 70) / 25, 0.2, 1)
}

const graphTrackedBySymbol = computed(() => new Map((props.graphSummary?.trackedNodes || []).map(node => [node.symbol, node])))
const graphMaxDegree = computed(() => Math.max(1, ...(props.graphSummary?.trackedNodes || []).map(node => node.degree || 0)))
const graphTopTrackedNodes = computed(() => (props.graphSummary?.trackedNodes || [])
  .filter(node => node.present && node.degree > 0)
  .sort((a, b) => b.degree - a.degree || a.symbol.localeCompare(b.symbol))
  .slice(0, 8))

function graphDegree(symbol: string): number {
  return graphTrackedBySymbol.value.get(symbol)?.degree || 0
}

function graphDegreeStrength(symbol: string): number {
  return clamp(graphDegree(symbol) / graphMaxDegree.value, 0, 1)
}

function graphAdjustedSize(symbol: string, baseSize: number): number {
  return baseSize + graphDegreeStrength(symbol) * 7
}

function graphAdjustedStatus(symbol: string, fallback: GraphStatus): GraphStatus {
  if (graphDegreeStrength(symbol) >= 0.75) return 'triggered'
  if (graphDegreeStrength(symbol) >= 0.42) return 'analyzing'
  return fallback
}

function createNodeBlueprint(
  id: string,
  label: string,
  type: GraphNodeType,
  status: GraphStatus,
  size: number,
  details: Record<string, unknown>,
  anchorX?: number,
  anchorY?: number,
): Omit<GraphNode, 'x' | 'y' | 'vx' | 'vy' | 'createdAt'> {
  return { id, label, type, status, size, details, anchorX, anchorY }
}

function buildGraphBlueprint() {
  const nodes: Array<Omit<GraphNode, 'x' | 'y' | 'vx' | 'vy' | 'createdAt'>> = []
  const links: GraphLink[] = []
  const top = props.topPicks.slice(0, 10)
  const width = stageWidth.value
  const height = stageHeight.value

  nodes.push(
    createNodeBlueprint('SPY', 'SPY', 'macro', 'idle', 8, { value: getPulseValue('SPY') }, width * 0.14, height * 0.34),
    createNodeBlueprint('QQQ', 'QQQ', 'macro', 'triggered', 9, { value: getPulseValue('QQQ') }, width * 0.2, height * 0.68),
    createNodeBlueprint('VIX', 'VIX', 'risk', 'risk', 10, { value: getPulseValue('VIX') }, width * 0.78, height * 0.22),
    createNodeBlueprint('TNX', '10Y', 'risk', 'analyzing', 9, { value: getPulseValue('10Y') }, width * 0.82, height * 0.62),
    createNodeBlueprint(
      'MACRO_AGENT',
      '總經守門',
      'macro',
      macroRiskOffAlert.value ? 'risk' : 'analyzing',
      macroRiskOffAlert.value ? 15 : 12,
      {
        regime: macroRegimeLabel.value,
        riskMultiplier: macroRiskMultiplier.value,
        insight: macroInsightLine.value,
        vix: getPulseValue('VIX'),
        tenYearYield: getPulseValue('10Y'),
      },
      width * 0.34,
      height * 0.2,
    ),
    createNodeBlueprint('REGIME', getPulseValue('Regime').replace(/Risk-on/gi, '風險偏好').replace(/Risk-off/gi, '避險').replace(/Mixed/gi, '混合'), 'signal', 'triggered', 13, { regime: getPulseValue('Regime') }, width * 0.5, height * 0.16),
    createNodeBlueprint('AI_FLOW', 'AI 資金流', 'flow', 'analyzing', 12, { theme: 'AI capex / semis / mega-cap rotation' }, width * 0.36, height * 0.48),
    createNodeBlueprint('RISK_CONTROL', '風控閘門', 'risk', props.guardrails?.status === 'BLOCKED' ? 'risk' : 'idle', 11, { ...(props.guardrails || {}) }, width * 0.7, height * 0.48),
    createNodeBlueprint('TOP10', '前十', 'signal', 'analyzing', 12, { count: top.length }, width * 0.5, height * 0.78),
    createNodeBlueprint('HERMES_DECISION', '決策核心', 'decision', 'triggered', 15, { ...props.decision }, width * 0.5, height * 0.5),
  )

  if (props.latestSeed) {
    nodes.push(createNodeBlueprint('MIROFISH_SEED', '情境種子', 'seed', 'triggered', 10, { ...props.latestSeed }, width * 0.66, height * 0.82))
  }

  if (props.graphSummary?.ok) {
    nodes.push(createNodeBlueprint(
      'MIROFISH_GRAPH',
      '圖譜資料',
      'seed',
      'triggered',
      clamp(8 + Math.log10(Math.max(props.graphSummary.nodeCount + props.graphSummary.edgeCount, 10)) * 4, 12, 20),
      {
        graphId: props.graphSummary.graphId,
        source: props.graphSummary.source,
        nodeCount: props.graphSummary.nodeCount,
        edgeCount: props.graphSummary.edgeCount,
        topNodes: props.graphSummary.topNodes.slice(0, 5),
      },
      width * 0.66,
      height * 0.7,
    ))
  }

  top.forEach((pick, index) => {
    const orbit = index / Math.max(top.length, 1)
    const angle = orbit * Math.PI * 2
    const anchorRadiusX = width * 0.34
    const anchorRadiusY = height * 0.3
    const anchorX = width * 0.5 + Math.cos(angle) * anchorRadiusX
    const anchorY = height * 0.52 + Math.sin(angle) * anchorRadiusY
    const degree = graphDegree(pick.ticker)
    const graphNode = graphTrackedBySymbol.value.get(pick.ticker)
    nodes.push(createNodeBlueprint(
      pick.ticker,
      pick.ticker,
      'symbol',
      graphAdjustedStatus(pick.ticker, toneStatus(pick)),
      graphAdjustedSize(pick.ticker, 7 + scoreStrength(pick.score) * 7),
      {
        ticker: pick.ticker,
        score: pick.score,
        action: pick.action,
        risk: pick.risk,
        trend: pick.trend,
        price: pick.price,
        reason: pick.reason,
        graphDegree: degree,
        graphName: graphNode?.name,
        graphLabels: graphNode?.labels,
        graphSummary: graphNode?.summary,
        graphRelatedEdges: graphNode?.relatedEdges?.slice(0, 3),
        scoreBreakdown: pick.scoreBreakdown,
        position: props.positions.find(position => position.ticker === pick.ticker) || null,
      },
      anchorX,
      anchorY,
    ))

    const thematicSource = /ai|semi|accelerator|cloud/i.test(pick.reason) ? 'AI_FLOW' : 'TOP10'
    links.push({
      id: `${thematicSource}-${pick.ticker}`,
      source: thematicSource,
      target: pick.ticker,
      strength: clamp(scoreStrength(pick.score) + graphDegreeStrength(pick.ticker) * 0.24, 0.2, 1),
      active: pick.action === 'BUY' || pick.score >= 88 || graphDegreeStrength(pick.ticker) >= 0.5,
      label: pick.reason,
    })
    links.push({
      id: `${pick.ticker}-decision`,
      source: pick.ticker,
      target: 'HERMES_DECISION',
      strength: clamp(scoreStrength(pick.score) * 0.85 + graphDegreeStrength(pick.ticker) * 0.18, 0.2, 1),
      active: pick.action === 'BUY' || graphDegreeStrength(pick.ticker) >= 0.75,
      label: `${pick.action} ${pick.score}`,
    })
  })

  if (props.graphSummary?.ok) {
    links.push({ id: 'GRAPH-DECISION', source: 'MIROFISH_GRAPH', target: 'HERMES_DECISION', strength: 0.78, active: true, label: `${props.graphSummary.nodeCount} 節點 / ${props.graphSummary.edgeCount} 連線` })
    graphTopTrackedNodes.value.forEach((node) => {
      if (!top.some(pick => pick.ticker === node.symbol)) return
      links.push({
        id: `GRAPH-${node.symbol}`,
        source: 'MIROFISH_GRAPH',
        target: node.symbol,
        strength: clamp(0.35 + node.degree / graphMaxDegree.value * 0.65, 0.35, 1),
        active: true,
        label: `graph degree ${node.degree}`,
      })
    })
  }

  props.journal.slice(0, 5).forEach((entry, index) => {
    const eventId = `EVENT-${entry.time}-${entry.ticker}-${entry.action}`.replace(/[^\w-]/g, '_')
    const isGuard = /risk|guard|blocked|loss|風控/i.test(`${entry.ticker} ${entry.note}`)
    const type: GraphNodeType = isGuard ? 'risk' : entry.action === 'BUY' || entry.action === 'SELL' ? 'decision' : 'signal'
    nodes.push(createNodeBlueprint(
      eventId,
      `${entry.ticker} ${entry.action}`,
      type,
      isGuard ? 'risk' : 'triggered',
      6.5,
      { ...entry },
      width * (0.18 + index * 0.13),
      height * 0.1,
    ))
    if (top.some(pick => pick.ticker === entry.ticker)) {
      links.push({
        id: `${entry.ticker}-${eventId}`,
        source: entry.ticker,
        target: eventId,
        strength: 0.7,
        active: true,
        label: entry.note,
      })
    }
    links.push({
      id: `${eventId}-decision`,
      source: eventId,
      target: isGuard ? 'RISK_CONTROL' : 'HERMES_DECISION',
      strength: 0.58,
      active: true,
      label: entry.note,
    })
  })

  links.push(
    { id: 'SPY-REGIME', source: 'SPY', target: 'REGIME', strength: 0.42, active: true, label: 'market breadth' },
    { id: 'QQQ-AI_FLOW', source: 'QQQ', target: 'AI_FLOW', strength: 0.65, active: true, label: 'growth beta' },
    { id: 'MACRO-DECISION', source: 'MACRO_AGENT', target: 'HERMES_DECISION', strength: macroRiskOffAlert.value ? 1 : 0.78, active: true, label: `macro multiplier ${macroRiskMultiplier.value.toFixed(2)}` },
    { id: 'VIX-RISK', source: 'VIX', target: 'RISK_CONTROL', strength: 0.88, active: getPulseValue('VIX').includes('+'), label: 'volatility pressure' },
    { id: 'TNX-RISK', source: 'TNX', target: 'RISK_CONTROL', strength: 0.76, active: true, label: 'yield pressure' },
    { id: 'REGIME-DECISION', source: 'REGIME', target: 'HERMES_DECISION', strength: 0.72, active: true, label: 'regime input' },
    { id: 'RISK-DECISION', source: 'RISK_CONTROL', target: 'HERMES_DECISION', strength: 0.8, active: props.guardrails?.status === 'BLOCKED', label: 'guardrails' },
  )

  if (props.latestSeed) {
    links.push({ id: 'DECISION-SEED', source: 'HERMES_DECISION', target: 'MIROFISH_SEED', strength: 0.68, active: true, label: 'simulation seed' })
  }

  return { nodes, links }
}

function syncGraph() {
  const previous = new Map(graphNodes.value.map(node => [node.id, node]))
  const blueprint = buildGraphBlueprint()
  const now = performance.now()
  const centerX = stageWidth.value / 2
  const centerY = stageHeight.value / 2
  const nextNodes = blueprint.nodes.map((node, index) => {
    const existing = previous.get(node.id)
    if (existing) {
      return {
        ...existing,
        ...node,
        details: node.details,
      }
    }

    const parentLink = blueprint.links.find(link => link.target === node.id)
    const parent = parentLink ? previous.get(parentLink.source) : null
    const angle = (index / Math.max(blueprint.nodes.length, 1)) * Math.PI * 2
    return {
      ...node,
      x: parent?.x ?? node.anchorX ?? centerX + Math.cos(angle) * 40,
      y: parent?.y ?? node.anchorY ?? centerY + Math.sin(angle) * 40,
      vx: 0,
      vy: 0,
      createdAt: now,
    }
  })

  graphNodes.value = nextNodes
  graphLinks.value = blueprint.links
}

function resizeCanvas() {
  const stage = stageRef.value
  const canvas = canvasRef.value
  if (!stage) return
  const rect = stage.getBoundingClientRect()
  const width = Math.max(rect.width, 320)
  const height = Math.max(rect.height, 380)
  const ratio = window.devicePixelRatio || 1
  stageWidth.value = width
  stageHeight.value = height
  if (canvas) {
    canvas.width = Math.floor(width * ratio)
    canvas.height = Math.floor(height * ratio)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }
  syncGraph()
}

function nodeColor(node: GraphNode): string {
  if (node.id === 'MACRO_AGENT' && macroRiskOffAlert.value) return '#ff003c'
  return typeColors[node.type] || '#ffffff'
}

function isMacroAlertLink(link: GraphLink): boolean {
  return macroRiskOffAlert.value && (link.source === 'MACRO_AGENT' || link.target === 'MACRO_AGENT')
}

function linkNodes(link: GraphLink): [GraphNode | undefined, GraphNode | undefined] {
  const nodes = graphNodes.value
  return [
    nodes.find(node => node.id === link.source),
    nodes.find(node => node.id === link.target),
  ]
}

function getNode(id: string): GraphNode | undefined {
  return graphNodes.value.find(node => node.id === id)
}

function getNodeTicker(node: GraphNode): string | null {
  if (node.type === 'symbol') return node.id
  if (typeof node.details.ticker === 'string') return node.details.ticker
  const match = node.label.match(/[A-Z][A-Z0-9.-]{0,6}/)
  return match?.[0] || null
}

function isNodeFocused(node: GraphNode): boolean {
  if (!focusMode.value || !activeTicker.value) return true
  const ticker = getNodeTicker(node)
  if (ticker === activeTicker.value) return true
  if (node.type === 'decision' || node.id === 'HERMES_DECISION') return true
  return graphLinks.value.some((link) => {
    const linkedToActive = (link.source === activeTicker.value || link.target === activeTicker.value)
    const linkedToNode = (link.source === node.id || link.target === node.id)
    return linkedToActive && linkedToNode
  })
}

function isLinkFocused(link: GraphLink): boolean {
  if (!focusMode.value || !activeTicker.value) return true
  return link.source === activeTicker.value || link.target === activeTicker.value
}

function applyForceLayout() {
  const nodes = graphNodes.value
  const links = graphLinks.value
  const width = stageWidth.value
  const height = stageHeight.value

  links.forEach(link => {
    const [source, target] = linkNodes(link)
    if (!source || !target) return
    const dx = target.x - source.x
    const dy = target.y - source.y
    const distance = Math.max(Math.hypot(dx, dy), 1)
    const desired = 82 + (1 - link.strength) * 80
    const force = (distance - desired) * 0.0018 * link.strength
    const fx = dx / distance * force
    const fy = dy / distance * force
    source.vx += fx
    source.vy += fy
    target.vx -= fx
    target.vy -= fy
  })

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distanceSq = Math.max(dx * dx + dy * dy, 36)
      const distance = Math.sqrt(distanceSq)
      const force = Math.min(240 / distanceSq, 0.08)
      const fx = dx / distance * force
      const fy = dy / distance * force
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }

  nodes.forEach(node => {
    const anchorX = node.anchorX ?? width / 2
    const anchorY = node.anchorY ?? height / 2
    node.vx += (anchorX - node.x) * 0.0009
    node.vy += (anchorY - node.y) * 0.0009
    node.vx *= 0.86
    node.vy *= 0.86
    node.x = clamp(node.x + node.vx, 28, width - 28)
    node.y = clamp(node.y + node.vy, 28, height - 28)
  })
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.save()
  ctx.strokeStyle = 'rgba(35, 247, 255, 0.07)'
  ctx.lineWidth = 1
  for (let x = 0; x <= width; x += 44) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = 0; y <= height; y += 44) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  ctx.restore()
}

function curvePoint(source: GraphNode, target: GraphNode, t: number) {
  const mx = (source.x + target.x) / 2
  const my = (source.y + target.y) / 2 - Math.min(36, Math.abs(target.x - source.x) * 0.12)
  const x = (1 - t) * (1 - t) * source.x + 2 * (1 - t) * t * mx + t * t * target.x
  const y = (1 - t) * (1 - t) * source.y + 2 * (1 - t) * t * my + t * t * target.y
  return { x, y, mx, my }
}

function svgLinkPath(link: GraphLink): string {
  const source = getNode(link.source)
  const target = getNode(link.target)
  if (!source || !target) return ''
  const { mx, my } = curvePoint(source, target, 0.5)
  return `M ${source.x} ${source.y} Q ${mx} ${my} ${target.x} ${target.y}`
}

function svgLinkStroke(link: GraphLink): string {
  if (isMacroAlertLink(link)) return '#ff003c'
  const target = getNode(link.target)
  return target ? nodeColor(target) : '#23f7ff'
}

function svgParticlePoints(link: GraphLink) {
  if (!link.active && link.strength < 0.7) return []
  const source = getNode(link.source)
  const target = getNode(link.target)
  if (!source || !target) return []
  const count = link.active ? 3 : 1
  return Array.from({ length: count }, (_, index) => {
    const t = ((animationNow.value * (link.active ? 0.00032 : 0.00013)) + index / count) % 1
    return curvePoint(source, target, t)
  })
}

function drawLinks(ctx: CanvasRenderingContext2D, time: number) {
  graphLinks.value.forEach(link => {
    const [source, target] = linkNodes(link)
    if (!source || !target) return
    const focused = isLinkFocused(link)
    const { mx, my } = curvePoint(source, target, 0.5)
    const macroAlert = isMacroAlertLink(link)
    const gradient = ctx.createLinearGradient(source.x, source.y, target.x, target.y)
    gradient.addColorStop(0, macroAlert ? '#ff003ccc' : `${nodeColor(source)}66`)
    gradient.addColorStop(1, macroAlert ? '#ff003cff' : `${nodeColor(target)}aa`)

    ctx.save()
    ctx.strokeStyle = gradient
    ctx.lineWidth = macroAlert ? 4.8 + Math.sin(time / 120) * 1.2 : 0.7 + link.strength * 2.2
    ctx.shadowColor = macroAlert ? '#ff003c' : link.active ? nodeColor(target) : 'transparent'
    ctx.shadowBlur = macroAlert ? 28 : link.active ? 12 : 0
    ctx.globalAlpha = focused ? 1 : 0.14
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.quadraticCurveTo(mx, my, target.x, target.y)
    ctx.stroke()

    const particles = macroAlert ? 6 : link.active ? 3 : link.strength > 0.7 ? 1 : 0
    for (let i = 0; i < particles; i += 1) {
      const t = ((time * (link.active ? 0.00032 : 0.00013)) + i / Math.max(particles, 1)) % 1
      const point = curvePoint(source, target, t)
      const radius = link.active ? 2.7 : 1.8
      ctx.fillStyle = macroAlert ? '#ff003c' : nodeColor(target)
      ctx.shadowColor = macroAlert ? '#ff003c' : nodeColor(target)
      ctx.shadowBlur = macroAlert ? 28 : 18
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  })
}

function drawNodes(ctx: CanvasRenderingContext2D, time: number) {
  graphNodes.value.forEach(node => {
    const color = nodeColor(node)
    const focused = isNodeFocused(node)
    const macroAlert = node.id === 'MACRO_AGENT' && macroRiskOffAlert.value
    const age = clamp((time - node.createdAt) / 700, 0, 1)
    const degree = typeof node.details.graphDegree === 'number' ? node.details.graphDegree : 0
    const degreePulse = degree ? graphDegreeStrength(node.id) * 2.6 : 0
    const pulse = macroAlert
      ? (Math.sin(time / 95) + 1.2) * 6.2
      : node.status === 'triggered' || node.status === 'analyzing' || node.status === 'risk'
        ? (Math.sin(time / 190 + node.id.length) + 1) * (2.8 + degreePulse)
        : 0
    const riskBoost = macroAlert ? 4.5 : node.status === 'risk' ? 2.5 : 0
    const radius = (node.size + pulse + riskBoost) * age

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = focused ? 1 : 0.18
    ctx.shadowColor = color
    ctx.shadowBlur = (macroAlert ? 48 : node.status === 'triggered' ? 30 : node.status === 'risk' ? 26 : 18) + degreePulse * 4

    const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, radius * 3.6)
    glow.addColorStop(0, `${color}f2`)
    glow.addColorStop(0.24, `${color}8f`)
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius * 3.6, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
    ctx.fill()

    ctx.globalCompositeOperation = 'source-over'
    ctx.lineWidth = macroAlert ? 3.2 : 1.3
    ctx.strokeStyle = macroAlert ? '#ffb3c5' : 'rgba(238, 255, 255, 0.82)'
    ctx.stroke()

    if (activeTicker.value && getNodeTicker(node) === activeTicker.value) {
      ctx.lineWidth = 2.4
      ctx.strokeStyle = '#ffd700'
      ctx.shadowColor = '#ffd700'
      ctx.shadowBlur = 22
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius + 8, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.shadowBlur = 0
    ctx.fillStyle = '#eaffff'
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(node.label.slice(0, 16), node.x, node.y + radius + 12)
    if (degree) {
      ctx.fillStyle = '#00ff00'
      ctx.font = '900 9px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText(`d${degree}`, node.x, node.y + radius + 24)
    }
    ctx.restore()
  })
}

function renderFrame(time = performance.now()) {
  const canvas = canvasRef.value
  if (!canvas) {
    applyForceLayout()
    animationNow.value = time
    graphNodes.value = [...graphNodes.value]
    frameId = requestAnimationFrame(renderFrame)
    return
  }
  if (typeof canvas.getContext !== 'function') {
    supportsCanvas.value = false
    applyForceLayout()
    animationNow.value = time
    graphNodes.value = [...graphNodes.value]
    frameId = requestAnimationFrame(renderFrame)
    return
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    supportsCanvas.value = false
    applyForceLayout()
    animationNow.value = time
    graphNodes.value = [...graphNodes.value]
    frameId = requestAnimationFrame(renderFrame)
    return
  }
  supportsCanvas.value = true
  const ratio = window.devicePixelRatio || 1
  const width = stageWidth.value
  const height = stageHeight.value

  applyForceLayout()
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#02050a'
  ctx.fillRect(0, 0, width, height)
  drawGrid(ctx, width, height)
  drawLinks(ctx, time)
  drawNodes(ctx, time)
  frameId = requestAnimationFrame(renderFrame)
}

function updateHover(event: MouseEvent) {
  const target = canvasRef.value || stageRef.value
  if (!target) return
  const rect = target.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  tooltipPosition.value = { x: event.clientX + 18, y: event.clientY + 18 }
  let closest: GraphNode | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  graphNodes.value.forEach(node => {
    const distance = Math.hypot(node.x - x, node.y - y)
    if (distance < Math.max(node.size + 14, 22) && distance < closestDistance) {
      closest = node
      closestDistance = distance
    }
  })
  hoverNode.value = closest
  if (stageRef.value) {
    stageRef.value.style.cursor = closest && getNodeTicker(closest) ? 'pointer' : 'default'
  }
}

function handleClick(event: MouseEvent) {
  updateHover(event)
  const node = hoverNode.value
  if (!node) return

  const ticker = getNodeTicker(node)
  emit('nodeClick', {
    id: node.id,
    label: node.label,
    type: node.type,
    ticker,
    details: node.details,
  })
}

watch(
  () => [props.topPicks, props.marketPulse, props.guardrails, props.latestSeed, props.graphSummary, props.journal, props.positions, props.decision],
  () => {
    nextTick(syncGraph)
  },
  { deep: true, immediate: true },
)

onMounted(() => {
  resizeCanvas()
  resizeObserver = new ResizeObserver(resizeCanvas)
  if (stageRef.value) resizeObserver.observe(stageRef.value)
  frameId = requestAnimationFrame(renderFrame)
})

onBeforeUnmount(() => {
  if (frameId) cancelAnimationFrame(frameId)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="stageRef" class="scenario-graph" :class="{ 'macro-alert': macroRiskOffAlert }" @mousemove="updateHover" @mouseleave="hoverNode = null" @click="handleClick">
    <canvas v-if="supportsCanvas" ref="canvasRef" class="scenario-canvas" aria-label="情境網路圖" />
    <svg
      v-else
      class="scenario-svg"
      :viewBox="`0 0 ${stageWidth} ${stageHeight}`"
      role="img"
      aria-label="情境網路圖備援"
    >
      <defs>
        <filter id="scenarioSvgGlow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g class="svg-grid">
        <path
          v-for="x in Math.ceil(stageWidth / 44)"
          :key="`vx-${x}`"
          :d="`M ${x * 44} 0 V ${stageHeight}`"
        />
        <path
          v-for="y in Math.ceil(stageHeight / 44)"
          :key="`hy-${y}`"
          :d="`M 0 ${y * 44} H ${stageWidth}`"
        />
      </g>
      <g class="svg-links">
        <path
          v-for="link in graphLinks"
          :key="link.id"
          :d="svgLinkPath(link)"
          :stroke="svgLinkStroke(link)"
          :stroke-width="isMacroAlertLink(link) ? 5 : 0.7 + link.strength * 2.2"
          :class="{ active: link.active, 'macro-alert': isMacroAlertLink(link) }"
        />
      </g>
      <g class="svg-particles">
        <template v-for="link in graphLinks" :key="`particles-${link.id}`">
          <circle
            v-for="(point, index) in svgParticlePoints(link)"
            :key="`${link.id}-${index}`"
            :cx="point.x"
            :cy="point.y"
            :r="link.active ? 3 : 2"
            :fill="svgLinkStroke(link)"
          />
        </template>
      </g>
      <g class="svg-nodes">
        <g
          v-for="node in graphNodes"
          :key="node.id"
          class="svg-node"
          :class="{ dimmed: !isNodeFocused(node), active: activeTicker && getNodeTicker(node) === activeTicker, 'macro-alert': node.id === 'MACRO_AGENT' && macroRiskOffAlert }"
          @click.stop="emit('nodeClick', { id: node.id, label: node.label, type: node.type, ticker: getNodeTicker(node), details: node.details })"
        >
          <circle
            class="svg-node-glow"
            :cx="node.x"
            :cy="node.y"
            :r="node.size * 3.2"
            :fill="nodeColor(node)"
          />
          <circle
            :cx="node.x"
            :cy="node.y"
            :r="node.size + (node.status === 'triggered' || node.status === 'analyzing' || node.status === 'risk' ? 2 : 0)"
            :fill="nodeColor(node)"
            :class="`status-${node.status}`"
          />
          <text :x="node.x" :y="node.y + node.size + 14">{{ node.label.slice(0, 16) }}</text>
        </g>
      </g>
    </svg>
    <div class="graph-hud top-left">
      <span>情境網路</span>
      <strong>{{ activeTicker || topPicks[0]?.ticker || '—' }} {{ topPicks.find(pick => pick.ticker === activeTicker)?.score || topPicks[0]?.score || '—' }}</strong>
    </div>
    <div class="graph-hud top-right">
      <span>市場狀態</span>
      <strong>{{ getPulseValue('Regime').replace(/Risk-on/gi, '風險偏好').replace(/Risk-off/gi, '避險').replace(/Mixed/gi, '混合') }}</strong>
    </div>
    <div class="graph-legend">
      <div v-for="item in legendItems" :key="item.type">
        <i :style="{ backgroundColor: item.color, boxShadow: `0 0 12px ${item.color}` }" />
        <span>{{ item.label }}</span>
      </div>
    </div>
    <div
      v-if="hoverNode"
      class="graph-tooltip"
      :style="{ left: `${tooltipPosition.x}px`, top: `${tooltipPosition.y}px`, borderColor: nodeColor(hoverNode), boxShadow: `0 0 30px ${nodeColor(hoverNode)}66` }"
    >
      <span :style="{ color: nodeColor(hoverNode) }">{{ displayGraphType(hoverNode.type) }} / {{ displayGraphStatus(hoverNode.status) }}</span>
      <strong>{{ hoverNode.label }}</strong>
      <pre>{{ JSON.stringify(hoverNode.details, null, 2) }}</pre>
    </div>
  </div>
</template>

<style scoped lang="scss">
.scenario-graph {
  position: relative;
  width: 100%;
  height: clamp(390px, 48vh, 520px);
  min-height: 390px;
  overflow: hidden;
  border: 1px solid rgba(35, 247, 255, 0.16);
  background: #02050a;

  &.macro-alert {
    border-color: rgba(255, 0, 60, 0.48);
    animation: macroPanelPulse 1.05s ease-in-out infinite;
  }
}

.scenario-canvas,
.scenario-svg {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 390px;
}

.scenario-svg {
  background: #02050a;
}

.svg-grid path {
  stroke: rgba(35, 247, 255, 0.07);
  stroke-width: 1;
}

.svg-links path {
  fill: none;
  opacity: 0.62;
  filter: url("#scenarioSvgGlow");

  &.active {
    opacity: 0.95;
  }

  &.macro-alert {
    opacity: 1;
    stroke: #ff003c;
    animation: macroLinkPulse 0.72s ease-in-out infinite;
  }
}

.svg-particles circle {
  filter: url("#scenarioSvgGlow");
}

.svg-node-glow {
  opacity: 0.26;
  filter: url("#scenarioSvgGlow");
}

.svg-node circle:not(.svg-node-glow) {
  stroke: rgba(238, 255, 255, 0.86);
  stroke-width: 1.2;
  filter: url("#scenarioSvgGlow");
}

.svg-node text {
  fill: #eaffff;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  text-anchor: middle;
}

.svg-node {
  cursor: pointer;

  &.dimmed {
    opacity: 0.18;
  }

  &.active circle:not(.svg-node-glow) {
    stroke: #ffd700;
    stroke-width: 2.4;
  }

  &.macro-alert {
    animation: macroNodePulse 0.72s ease-in-out infinite;

    .svg-node-glow {
      opacity: 0.62;
    }

    circle:not(.svg-node-glow) {
      stroke: #ffb3c5;
      stroke-width: 3;
    }
  }
}

.status-triggered,
.status-analyzing,
.status-risk {
  transform-origin: center;
  animation: svgNodePulse 1.7s ease-in-out infinite;
}

@keyframes svgNodePulse {
  0%,
  100% {
    opacity: 0.82;
  }

  50% {
    opacity: 1;
  }
}

@keyframes macroPanelPulse {
  0%,
  100% {
    box-shadow: inset 0 0 0 rgba(255, 0, 60, 0), 0 0 0 rgba(255, 0, 60, 0);
  }

  50% {
    box-shadow: inset 0 0 18px rgba(255, 0, 60, 0.18), 0 0 22px rgba(255, 0, 60, 0.22);
  }
}

@keyframes macroNodePulse {
  0%,
  100% {
    opacity: 0.82;
    filter: drop-shadow(0 0 8px rgba(255, 0, 60, 0.55));
  }

  50% {
    opacity: 1;
    filter: drop-shadow(0 0 24px rgba(255, 0, 60, 0.95));
  }
}

@keyframes macroLinkPulse {
  0%,
  100% {
    filter: drop-shadow(0 0 4px rgba(255, 0, 60, 0.55));
  }

  50% {
    filter: drop-shadow(0 0 18px rgba(255, 0, 60, 0.95));
  }
}

.graph-hud {
  position: absolute;
  z-index: 2;
  min-width: 122px;
  padding: 9px 10px;
  border: 1px solid rgba(35, 247, 255, 0.22);
  background: rgba(3, 8, 14, 0.74);
  backdrop-filter: blur(8px);

  span,
  strong {
    display: block;
    font-family: "SFMono-Regular", Consolas, monospace;
    line-height: 1.25;
  }

  span {
    color: #7f8b98;
    font-size: 10px;
  }

  strong {
    margin-top: 4px;
    color: #eaffff;
    font-size: 12px;
  }
}

.top-left {
  top: 10px;
  left: 10px;
}

.top-right {
  top: 10px;
  right: 10px;
  min-width: 96px;
}

.graph-legend {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(3, auto);
  gap: 6px 12px;
  padding: 8px 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(3, 8, 14, 0.66);
  backdrop-filter: blur(8px);

  div {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  i {
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 999px;
  }

  span {
    color: #aeb9c6;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 10px;
    line-height: 1;
  }
}

.graph-tooltip {
  position: fixed;
  z-index: 50;
  width: min(320px, calc(100vw - 34px));
  max-height: 340px;
  overflow: hidden;
  padding: 12px;
  border: 1px solid;
  border-radius: 6px;
  background: rgba(5, 10, 18, 0.94);
  color: #eaffff;
  pointer-events: none;
  backdrop-filter: blur(10px);

  span,
  strong,
  pre {
    font-family: "SFMono-Regular", Consolas, monospace;
  }

  span {
    display: block;
    font-size: 10px;
    line-height: 1.2;
    text-transform: uppercase;
  }

  strong {
    display: block;
    margin-top: 6px;
    color: #f8fbff;
    font-size: 15px;
    line-height: 1.25;
  }

  pre {
    margin: 10px 0 0;
    max-height: 230px;
    overflow: hidden;
    color: #aeb9c6;
    font-size: 10px;
    line-height: 1.45;
    white-space: pre-wrap;
  }
}

@media (max-width: 720px) {
  .graph-legend {
    grid-template-columns: repeat(2, auto);
  }

  .graph-hud {
    min-width: 0;
  }
}
</style>
