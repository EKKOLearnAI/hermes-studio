<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchJourneyGraph, type JourneyGraphResponse, type JourneyMemory, type JourneyNode } from '@/api/hermes/journey'
import { fetchSkills, type SkillsData } from '@/api/hermes/skills'
import { useTheme } from '@/composables/useTheme'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { normalizeSkillDescription, skillDescriptionPreview } from '@/utils/hermes/skill-display'

interface SceneNode extends JourneyNode {
  x: number
  y: number
  z: number
  radius: number
  color: string
}

interface ProjectedNode extends SceneNode {
  sx: number
  sy: number
  depth: number
  size: number
  visible: boolean
}

type SkillDescriptionLoadState = 'idle' | 'loading' | 'loaded' | 'failed'
type NodeShape = 'circle' | 'diamond'

const CATEGORY_PALETTE = [
  '#4f8cff',
  '#ff4fa3',
  '#38c976',
  '#f6c542',
  '#9b6cff',
  '#ff7a45',
  '#22c7d8',
  '#e84d5b',
  '#7cb342',
  '#d66efd',
  '#00a884',
  '#ff9f1a',
]
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.4

const { t } = useI18n()
const message = useMessage()
const { isDark } = useTheme()
const profilesStore = useProfilesStore()

const data = ref<JourneyGraphResponse | null>(null)
const loading = ref(false)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const canvasWrapRef = ref<HTMLElement | null>(null)
const selectedId = ref('')
const hoverId = ref('')
const hoverCategory = ref('')
const selectedCategories = ref<string[]>([])
const skillDescriptions = ref(new Map<string, string>())
const hoverTipId = ref('')
const hoverPoint = ref({ x: 0, y: 0 })
const playing = ref(false)
const playbackIndex = ref(-1)
const detailDrawerOpen = ref(false)
const drawerWidth = ref(380)

let ctx: CanvasRenderingContext2D | null = null
let resizeObserver: ResizeObserver | null = null
let raf = 0
let width = 1
let height = 1
let dpr = 1
let rotationX = -0.25
let rotationY = 0.55
let zoom = 1
let dragging = false
let lastX = 0
let lastY = 0
let pinchDistance = 0
let pinchZoom = 1
let playbackTimer: number | null = null
let clearSelectionTimer: number | null = null
let hoverTipTimer: number | null = null
let pendingHoverTipId = ''
let pointerStartX = 0
let pointerStartY = 0
let pointerMoved = false
let suppressClickUntil = 0
let keyboardPreviewIndex = -1
let disposed = false
let loadGeneration = 0
let skillDescriptionLoadGeneration = 0
let skillDescriptionLoadState: SkillDescriptionLoadState = 'idle'
let skillDescriptionLoadPromise: Promise<void> | null = null
let resizeListenerInstalled = false
let resizeObserverInstalled = false
let rendererStarted = false
const activePointers = new Map<number, { x: number; y: number }>()

const nodes = computed(() => data.value?.graph.nodes || [])
const edges = computed(() => data.value?.graph.edges || [])
const selectedNode = computed(() => nodes.value.find(node => node.id === selectedId.value) || null)
const playbackNodes = computed(() =>
  nodes.value
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const aTime = a.node.timestamp
      const bTime = b.node.timestamp
      if (aTime && bTime && aTime !== bTime) return aTime - bTime
      if (aTime && !bTime) return -1
      if (!aTime && bTime) return 1
      return a.index - b.index
    })
    .map(item => item.node),
)
const revealedNodeIds = computed(() => {
  if (playbackIndex.value < 0) return null
  return new Set(playbackNodes.value.slice(0, playbackIndex.value + 1).map(node => node.id))
})
const visibleEdges = computed(() => {
  const revealed = revealedNodeIds.value
  if (!revealed) return edges.value
  return edges.value.filter(edge => revealed.has(edge.source) && revealed.has(edge.target))
})

const sceneNodes = computed<SceneNode[]>(() => {
  const categories = [...new Set(nodes.value.map(node => node.category || 'general'))].sort()
  const categoryIndex = new Map(categories.map((category, index) => [category, index]))
  const categoryCount = Math.max(1, categoryIndex.size)
  const clusterCenters = new Map<string, { x: number; y: number; z: number }>()
  const densityScale = Math.min(2.3, Math.max(1, Math.sqrt(Math.max(nodes.value.length, 1) / 42)))
  const clusterRadius = 360 * densityScale

  for (const [category, index] of categoryIndex) {
    const angle = (index / categoryCount) * Math.PI * 2
    const pitch = ((index % 5) - 2) * 0.42
    clusterCenters.set(category, {
      x: Math.cos(angle) * Math.cos(pitch) * clusterRadius,
      y: Math.sin(pitch) * clusterRadius * 0.72,
      z: Math.sin(angle) * Math.cos(pitch) * clusterRadius,
    })
  }

  return nodes.value.map((node, index) => {
    const category = node.category || 'general'
    const center = clusterCenters.get(category) || { x: 0, y: 0, z: 0 }
    const seed = hash(`${node.id}:${index}`)
    const a = (seed % 6283) / 1000
    const b = ((seed >> 8) % 3141) / 1000
    const spread = (node.kind === 'memory' ? 125 : 165) * densityScale
    return {
      ...node,
      x: center.x + Math.cos(a) * Math.sin(b) * spread,
      y: center.y + Math.cos(b) * spread * 0.85,
      z: center.z + Math.sin(a) * Math.sin(b) * spread,
      radius: node.kind === 'memory' ? 6 : Math.min(13, 5 + Math.sqrt(node.useCount || 0) * 1.7),
      color: node.kind === 'memory' ? '#6ba3d6' : categoryColor(category),
    }
  })
})

const nodeById = computed(() => new Map(sceneNodes.value.map(node => [node.id, node])))
const visibleSceneNodes = computed(() => {
  const revealed = revealedNodeIds.value
  if (!revealed) return sceneNodes.value
  return sceneNodes.value.filter(node => revealed.has(node.id))
})
const categoryStats = computed(() => {
  const stats = new Map<string, { category: string; label: string; color: string; count: number }>()
  for (const node of visibleSceneNodes.value) {
    const category = node.category || 'general'
    const current = stats.get(category)
    if (current) {
      current.count += 1
    } else {
      stats.set(category, {
        category,
        label: node.category || t('journey.noCategory'),
        color: node.color,
        count: 1,
      })
    }
  }
  return [...stats.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
})
const visibleNodeCount = computed(() => Math.max(1, visibleSceneNodes.value.length))
const selectedCategorySet = computed(() => new Set(selectedCategories.value))
const emphasizedCategorySet = computed(() => {
  const categories = new Set(selectedCategories.value)
  if (hoverCategory.value) categories.add(hoverCategory.value)
  return categories
})
const hoverTipNode = computed(() => hoverTipId.value ? nodeById.value.get(hoverTipId.value) || null : null)
const hoverTipTitle = computed(() => hoverTipNode.value?.label || hoverTipNode.value?.id || '')
const hoverTipDescription = computed(() => {
  const node = hoverTipNode.value
  if (!node) return ''
  if (isMemoryNode(node)) return skillDescriptionPreview(memoryText(node))
  return skillDescriptionPreview(skillDescription(node))
})
const selectedSkillDescription = computed(() => {
  const node = selectedNode.value
  return node && !isMemoryNode(node) ? skillDescription(node) : ''
})
const canvasAriaLabel = computed(() =>
  `${t('journey.title')}. ${visibleSceneNodes.value.length} ${t('journey.nodes')}. ${t('journey.canvasInstructions')}`,
)
const hoverTipStyle = computed(() => {
  const tooltipWidth = 320
  const gap = 14
  const x = hoverPoint.value.x + gap + tooltipWidth <= width
    ? hoverPoint.value.x + gap
    : Math.max(8, hoverPoint.value.x - tooltipWidth - gap)
  const above = hoverPoint.value.y > height - 150
  return {
    left: `${x}px`,
    top: `${Math.max(8, hoverPoint.value.y + (above ? -gap : gap))}px`,
    transform: above ? 'translateY(-100%)' : undefined,
  }
})

function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function categoryColor(category: string): string {
  const categories = [...new Set(nodes.value.map(node => node.category || 'general'))].sort()
  const index = categories.indexOf(category)
  if (index >= 0) return CATEGORY_PALETTE[index % CATEGORY_PALETTE.length]
  return CATEGORY_PALETTE[hash(category) % CATEGORY_PALETTE.length]
}

function formatTime(value?: number | null): string {
  if (!value) return '-'
  return new Date(value * 1000).toLocaleString()
}

function isMemoryNode(node: JourneyNode | null): boolean {
  return node?.kind === 'memory'
}

function detailTitle(node: JourneyNode): string {
  if (isMemoryNode(node)) return node.category || t('journey.memories')
  return node.label || node.id
}

function memoryIndex(node: JourneyNode): number | null {
  const index = Number(node.id.split(':').pop())
  return Number.isInteger(index) && index >= 0 ? index : null
}

function memoryRecord(node: JourneyNode | null): JourneyMemory | null {
  if (!node || !isMemoryNode(node)) return null
  const memories = data.value?.graph.memory || []
  const index = memoryIndex(node)
  if (index !== null) {
    const match = memories[index]
    if (match && (!node.memorySource || !match.source || match.source === node.memorySource)) return match
  }
  return memories.find(memory =>
    (!node.memorySource || !memory.source || memory.source === node.memorySource)
    && (!node.timestamp || !memory.timestamp || memory.timestamp === node.timestamp),
  ) || null
}

function memoryText(node: JourneyNode): string {
  const memory = memoryRecord(node)
  return memory?.body || memory?.title || node.label || ''
}

function skillDescriptionIdentityKey(category: string, name: string): string {
  return `category:${category}\u0000${name}`
}

function skillDescriptionNameKey(name: string): string {
  return `name:${name}`
}

function skillDescription(node: JourneyNode): string {
  const category = node.category || 'general'
  const idName = node.id.replace(/^skill:/, '')
  return normalizeSkillDescription(
    skillDescriptions.value.get(skillDescriptionIdentityKey(category, node.label))
    || skillDescriptions.value.get(skillDescriptionIdentityKey(category, idName))
    || skillDescriptions.value.get(skillDescriptionNameKey(node.label))
    || skillDescriptions.value.get(skillDescriptionNameKey(idName))
    || '',
  )
}

function skillDescriptionMap(skills: SkillsData): Map<string, string> {
  const descriptions = new Map<string, string>()
  const names = new Map<string, { count: number; description: string }>()
  const addName = (name: string, description: string) => {
    const current = names.get(name)
    names.set(name, {
      count: (current?.count || 0) + 1,
      description: current?.description || description,
    })
  }

  for (const category of skills.categories || []) {
    for (const skill of category.skills || []) {
      descriptions.set(skillDescriptionIdentityKey(category.name, skill.name), skill.description || '')
      addName(skill.name, skill.description || '')
    }
  }
  for (const skill of skills.archived || []) addName(skill.name, skill.description || '')
  for (const [name, entry] of names) {
    if (entry.count === 1) descriptions.set(skillDescriptionNameKey(name), entry.description)
  }
  return descriptions
}

function resetSkillDescriptionLoad(generation: number) {
  skillDescriptions.value = new Map()
  skillDescriptionLoadGeneration = generation
  skillDescriptionLoadState = 'idle'
  skillDescriptionLoadPromise = null
}

function ensureSkillDescriptionsLoaded(generation = loadGeneration): Promise<void> | undefined {
  if (disposed || generation !== loadGeneration) return undefined
  if (skillDescriptionLoadGeneration !== generation) resetSkillDescriptionLoad(generation)
  if (skillDescriptionLoadState === 'loaded' || skillDescriptionLoadState === 'failed') return skillDescriptionLoadPromise || undefined
  if (skillDescriptionLoadState === 'loading') return skillDescriptionLoadPromise || undefined

  skillDescriptionLoadState = 'loading'
  const completion = fetchSkills()
    .then((skills) => {
      if (disposed || generation !== loadGeneration || generation !== skillDescriptionLoadGeneration) return
      skillDescriptions.value = skillDescriptionMap(skills)
      skillDescriptionLoadState = 'loaded'
    })
    .catch(() => {
      if (disposed || generation !== loadGeneration || generation !== skillDescriptionLoadGeneration) return
      skillDescriptionLoadState = 'failed'
    })
  skillDescriptionLoadPromise = completion
  void completion.finally(() => {
    if (generation === skillDescriptionLoadGeneration && skillDescriptionLoadPromise === completion) {
      skillDescriptionLoadPromise = null
    }
  })
  return completion
}

function requestSkillDescription(node: JourneyNode) {
  if (!isMemoryNode(node)) void ensureSkillDescriptionsLoaded()
}

function clearHoverTipTimer() {
  if (hoverTipTimer !== null) window.clearTimeout(hoverTipTimer)
  hoverTipTimer = null
  pendingHoverTipId = ''
}

function hideNodeHoverTip(clearHover = false) {
  clearHoverTipTimer()
  hoverTipId.value = ''
  if (clearHover) hoverId.value = ''
}

function updateNodeHover(hit: ProjectedNode | null, point: { x: number; y: number }) {
  hoverPoint.value = point
  hoverId.value = hit?.id || ''
  if (!hit) {
    hideNodeHoverTip()
    return
  }
  if (dragging) {
    hideNodeHoverTip(true)
    return
  }
  if (hoverTipId.value === hit.id || pendingHoverTipId === hit.id) return
  clearHoverTipTimer()
  hoverTipId.value = ''
  const targetId = hit.id
  pendingHoverTipId = targetId
  hoverTipTimer = window.setTimeout(() => {
    hoverTipTimer = null
    pendingHoverTipId = ''
    if (!disposed && !dragging && hoverId.value === targetId) {
      hoverTipId.value = targetId
      requestSkillDescription(hit)
    }
  }, 250)
}

function toggleCategorySelection(category: string) {
  const isSelected = selectedCategorySet.value.has(category)
  selectedCategories.value = isSelected
    ? selectedCategories.value.filter(value => value !== category)
    : [...selectedCategories.value, category]
}

function resetInteractionState() {
  stopPlayback()
  clearSelectionDelay()
  keyboardPreviewIndex = -1
  selectedId.value = ''
  hoverId.value = ''
  hoverCategory.value = ''
  selectedCategories.value = []
  hideNodeHoverTip()
  playbackIndex.value = -1
  detailDrawerOpen.value = false
}

function rotatePoint(node: SceneNode): { x: number; y: number; z: number } {
  const cosY = Math.cos(rotationY)
  const sinY = Math.sin(rotationY)
  const cosX = Math.cos(rotationX)
  const sinX = Math.sin(rotationX)
  const x1 = node.x * cosY - node.z * sinY
  const z1 = node.x * sinY + node.z * cosY
  const y1 = node.y * cosX - z1 * sinX
  const z2 = node.y * sinX + z1 * cosX
  return { x: x1, y: y1, z: z2 }
}

function projectNode(node: SceneNode): ProjectedNode {
  const rotated = rotatePoint(node)
  const camera = 860 / zoom
  const perspective = camera / (camera + rotated.z)
  const size = Math.max(2, node.radius * perspective * zoom)
  return {
    ...node,
    sx: width / 2 + rotated.x * perspective * zoom,
    sy: height / 2 + rotated.y * perspective * zoom,
    depth: rotated.z,
    size,
    visible: perspective > 0,
  }
}

function draw(now = performance.now()) {
  if (!ctx || disposed) return
  ctx.clearRect(0, 0, width, height)
  drawBackground()

  const projected = visibleSceneNodes.value.map(projectNode).filter(node => node.visible)
  const projectedById = new Map(projected.map(node => [node.id, node]))
  const activeIds = new Set<string>()
  if (selectedId.value) activeIds.add(selectedId.value)
  if (hoverId.value) activeIds.add(hoverId.value)
  const activeNeighbors = new Set<string>()

  for (const edge of visibleEdges.value) {
    if (activeIds.has(edge.source)) activeNeighbors.add(edge.target)
    if (activeIds.has(edge.target)) activeNeighbors.add(edge.source)
  }

  drawEdges(projectedById, activeIds, activeNeighbors, emphasizedCategorySet.value, now)
  projected
    .sort((a, b) => a.depth - b.depth)
    .forEach(node => drawNode(
      node,
      activeIds,
      activeNeighbors,
      emphasizedCategorySet.value,
      selectedCategorySet.value,
      now,
    ))

  raf = requestAnimationFrame(draw)
  rendererStarted = true
}

function drawBackground() {
  if (!ctx) return
  const gradient = ctx.createRadialGradient(width * 0.5, height * 0.42, 10, width * 0.5, height * 0.5, Math.max(width, height) * 0.68)
  gradient.addColorStop(0, 'rgba(74, 144, 217, 0.14)')
  gradient.addColorStop(0.46, 'rgba(120, 120, 120, 0.05)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
}

function drawEdges(
  projectedById: Map<string, ProjectedNode>,
  activeIds: Set<string>,
  activeNeighbors: Set<string>,
  activeCategories: Set<string>,
  now: number,
) {
  if (!ctx) return
  ctx.save()
  const pulse = 0.5 + Math.sin(now * 0.012) * 0.5
  for (const edge of visibleEdges.value) {
    const source = projectedById.get(edge.source)
    const target = projectedById.get(edge.target)
    if (!source || !target) continue
    const active = activeIds.has(edge.source) || activeIds.has(edge.target)
    const categoryActive = activeCategories.has(source.category || 'general')
      || activeCategories.has(target.category || 'general')
    const nearby = activeNeighbors.has(edge.source) || activeNeighbors.has(edge.target)
    const alpha = active ? 0.62 + pulse * 0.28 : categoryActive ? 0.46 : nearby ? 0.4 : isDark.value ? 0.1 : 0.22
    ctx.lineWidth = isDark.value ? 1 : 1.15
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.strokeStyle = isDark.value
      ? `rgba(180, 210, 255, ${alpha})`
      : `rgba(42, 58, 78, ${alpha})`
    const curve = edgeCurve(source, target, `${edge.source}:${edge.target}`)
    drawCurvedEdge(source, target, curve)
    if (active) drawPulseEdge(source, target, curve, pulse, now)
  }
  ctx.restore()
}

function edgeCurve(source: ProjectedNode, target: ProjectedNode, key: string): { cx: number; cy: number } | null {
  const dx = target.sx - source.sx
  const dy = target.sy - source.sy
  const length = Math.sqrt(dx * dx + dy * dy)
  if (length < 2) return null
  const normalX = -dy / length
  const normalY = dx / length
  const direction = hash(key) % 2 === 0 ? 1 : -1
  const curve = Math.min(58, Math.max(10, length * 0.12)) * direction
  return {
    cx: (source.sx + target.sx) / 2 + normalX * curve,
    cy: (source.sy + target.sy) / 2 + normalY * curve,
  }
}

function drawCurvedEdge(source: ProjectedNode, target: ProjectedNode, curve: { cx: number; cy: number } | null) {
  if (!ctx || !curve) return
  ctx.beginPath()
  ctx.moveTo(source.sx, source.sy)
  ctx.quadraticCurveTo(curve.cx, curve.cy, target.sx, target.sy)
  ctx.stroke()
}

function drawPulseEdge(source: ProjectedNode, target: ProjectedNode, curve: { cx: number; cy: number } | null, pulse: number, now: number) {
  if (!ctx || !curve) return
  const head = (now * 0.0018) % 1
  const tail = Math.max(0, head - 0.24)
  const points = sampleCurve(source, target, curve, 1 - head, 1 - tail, 18).reverse()
  const glowColor = isDark.value ? 'rgba(180, 225, 255, 0.92)' : 'rgba(74, 144, 217, 0.78)'
  const coreColor = isDark.value ? 'rgba(255, 255, 255, 0.96)' : 'rgba(255, 255, 255, 0.9)'
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.shadowColor = glowColor
  ctx.shadowBlur = 7 + pulse * 9
  ctx.strokeStyle = glowColor
  ctx.lineWidth = 2.2 + pulse * 1.2
  strokePath(points)

  ctx.shadowBlur = 2 + pulse * 4
  ctx.strokeStyle = coreColor
  ctx.lineWidth = 0.75 + pulse * 0.65
  strokePath(points)
  ctx.restore()
}

function sampleCurve(
  source: ProjectedNode,
  target: ProjectedNode,
  curve: { cx: number; cy: number },
  start: number,
  end: number,
  steps: number,
) {
  const points: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= steps; i += 1) {
    const t = start + (end - start) * (i / steps)
    const inv = 1 - t
    points.push({
      x: inv * inv * source.sx + 2 * inv * t * curve.cx + t * t * target.sx,
      y: inv * inv * source.sy + 2 * inv * t * curve.cy + t * t * target.sy,
    })
  }
  return points
}

function strokePath(points: Array<{ x: number; y: number }>) {
  if (!ctx || !points.length) return
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x, points[i].y)
  }
  ctx.stroke()
}

function nodeShape(node: Pick<JourneyNode, 'kind'>): NodeShape {
  return node.kind === 'memory' ? 'diamond' : 'circle'
}

function traceNodeShape(node: ProjectedNode, padding = 0) {
  if (!ctx) return
  const radius = Math.max(0, node.size + padding)
  ctx.beginPath()
  if (nodeShape(node) === 'diamond') {
    const horizontal = radius * 1.12
    const vertical = radius * 1.3
    ctx.moveTo(node.sx, node.sy - vertical)
    ctx.lineTo(node.sx + horizontal, node.sy)
    ctx.lineTo(node.sx, node.sy + vertical)
    ctx.lineTo(node.sx - horizontal, node.sy)
    ctx.lineTo(node.sx, node.sy - vertical)
    return
  }
  ctx.arc(node.sx, node.sy, radius, 0, Math.PI * 2)
}

function drawNode(
  node: ProjectedNode,
  activeIds: Set<string>,
  activeNeighbors: Set<string>,
  activeCategories: Set<string>,
  selectedCategoriesSet: Set<string>,
  now: number,
) {
  if (!ctx) return
  const active = activeIds.has(node.id)
  const nearby = activeNeighbors.has(node.id)
  const category = node.category || 'general'
  const categoryActive = activeCategories.has(category)
  const categorySelected = selectedCategoriesSet.has(category)
  const hasFocus = activeIds.size > 0 || activeCategories.size > 0
  const alpha = active || nearby || categoryActive || !hasFocus ? 1 : 0.24
  const pulse = active ? 0.5 + Math.sin(now * 0.005) * 0.5 : 0
  const glow = active ? 20 + pulse * 24 : categorySelected ? 16 : node.createdBy === 'agent' ? 12 : node.pinned ? 10 : 0
  const nodeBackdrop = isDark.value ? '#1a1a1a' : '#fafafa'

  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = nodeBackdrop
  traceNodeShape(node, -0.25)
  ctx.fill()

  ctx.globalAlpha = alpha
  if (glow) {
    ctx.shadowColor = node.color
    ctx.shadowBlur = glow
  }
  ctx.fillStyle = node.color
  traceNodeShape(node)
  ctx.fill()

  if (node.pinned || active || categorySelected) {
    ctx.shadowBlur = 0
    ctx.strokeStyle = active
      ? 'rgba(255,255,255,0.9)'
      : categorySelected
        ? node.color
        : 'rgba(255, 190, 90, 0.85)'
    ctx.lineWidth = active ? 2 : categorySelected ? 2.2 : 1.4
    traceNodeShape(node, categorySelected ? 6 : 5)
    ctx.stroke()
  }

  if (active) {
    ctx.shadowBlur = 0
    ctx.globalAlpha = 0.28 + pulse * 0.32
    ctx.strokeStyle = node.color
    ctx.lineWidth = 2
    traceNodeShape(node, 10 + pulse * 14)
    ctx.stroke()
  }
  ctx.restore()
}

function resizeCanvas() {
  const canvas = canvasRef.value
  const wrap = canvasWrapRef.value
  if (!canvas || !wrap) return
  const rect = wrap.getBoundingClientRect()
  dpr = window.devicePixelRatio || 1
  width = Math.max(1, rect.width)
  height = Math.max(1, rect.height)
  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function updateDrawerWidth() {
  drawerWidth.value = window.innerWidth <= 640 ? window.innerWidth : 380
}

function addResizeListener() {
  if (resizeListenerInstalled) return
  window.addEventListener('resize', updateDrawerWidth)
  resizeListenerInstalled = true
}

function removeResizeListener() {
  if (!resizeListenerInstalled) return
  window.removeEventListener('resize', updateDrawerWidth)
  resizeListenerInstalled = false
}

function attachResizeObserver() {
  if (resizeObserverInstalled || !canvasWrapRef.value) return
  resizeObserver = new ResizeObserver(resizeCanvas)
  resizeObserver.observe(canvasWrapRef.value)
  resizeObserverInstalled = true
}

function detachResizeObserver() {
  if (!resizeObserverInstalled) return
  resizeObserver?.disconnect()
  resizeObserver = null
  resizeObserverInstalled = false
}

function projectedVisibleNodes(): ProjectedNode[] {
  return visibleSceneNodes.value.map(projectNode).filter(node => node.visible)
}

function pointHitsNode(node: ProjectedNode, x: number, y: number): boolean {
  const dx = x - node.sx
  const dy = y - node.sy
  const hitRadius = node.size + 8
  return nodeShape(node) === 'diamond'
    ? Math.abs(dx) / (hitRadius * 1.12) + Math.abs(dy) / (hitRadius * 1.3) <= 1
    : Math.sqrt(dx * dx + dy * dy) <= hitRadius
}

function hitTest(x: number, y: number): ProjectedNode | null {
  const projected = projectedVisibleNodes()
  let best: ProjectedNode | null = null
  for (const node of projected) {
    if (pointHitsNode(node, x, y) && (!best || node.depth > best.depth)) best = node
  }
  return best
}

function pointerPosition(event: MouseEvent | PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = canvasRef.value?.getBoundingClientRect()
  return { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) }
}

function handlePointerDown(event: PointerEvent) {
  keyboardPreviewIndex = -1
  hideNodeHoverTip(true)
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (activePointers.size === 2) {
    const pointers = [...activePointers.values()]
    pinchDistance = pointerDistance(pointers[0], pointers[1])
    pinchZoom = zoom
    pointerMoved = true
    dragging = true
  } else {
    pointerStartX = event.clientX
    pointerStartY = event.clientY
    pointerMoved = false
    dragging = true
  }
  lastX = event.clientX
  lastY = event.clientY
  canvasRef.value?.setPointerCapture(event.pointerId)
}

function handlePointerMove(event: PointerEvent) {
  if (activePointers.has(event.pointerId)) {
    if (Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY) > 4) pointerMoved = true
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  }

  if (activePointers.size >= 2) {
    dragging = true
    hideNodeHoverTip(true)
    const pointers = [...activePointers.values()]
    const distance = pointerDistance(pointers[0], pointers[1])
    if (pinchDistance > 0) {
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchZoom * (distance / pinchDistance)))
    }
    return
  }

  const pos = pointerPosition(event)
  const hit = hitTest(pos.x, pos.y)
  updateNodeHover(hit, pos)
  if (!dragging) return
  const dx = event.clientX - lastX
  const dy = event.clientY - lastY
  rotationY += dx * 0.006
  rotationX = Math.max(-1.2, Math.min(1.2, rotationX + dy * 0.006))
  lastX = event.clientX
  lastY = event.clientY
}

function handlePointerUp(event: PointerEvent) {
  const cancelled = event.type === 'pointercancel'
  if (pointerMoved || cancelled) suppressClickUntil = performance.now() + 200
  activePointers.delete(event.pointerId)
  if (cancelled) {
    activePointers.clear()
    dragging = false
    pointerMoved = false
    pinchDistance = 0
    hideNodeHoverTip(true)
  } else if (activePointers.size === 1) {
    const pointer = [...activePointers.values()][0]
    lastX = pointer.x
    lastY = pointer.y
    dragging = true
  } else {
    dragging = false
    pointerMoved = false
    pinchDistance = 0
  }
  const canvas = canvasRef.value
  if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
}

function handlePointerLeave() {
  if (!dragging) hideNodeHoverTip(true)
}

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function previewNodeFromKeyboard(delta: number, absoluteIndex?: number) {
  const projected = projectedVisibleNodes()
  if (!projected.length) return
  const currentIndex = projected.findIndex(node => node.id === hoverTipId.value)
  let baseIndex = currentIndex
  if (baseIndex < 0) baseIndex = keyboardPreviewIndex >= 0 ? keyboardPreviewIndex : delta > 0 ? -1 : 0
  keyboardPreviewIndex = absoluteIndex === undefined
    ? (baseIndex + delta + projected.length) % projected.length
    : Math.max(0, Math.min(projected.length - 1, absoluteIndex))
  const node = projected[keyboardPreviewIndex]
  requestSkillDescription(node)
  clearHoverTipTimer()
  hoverId.value = node.id
  hoverTipId.value = node.id
  hoverPoint.value = { x: node.sx, y: node.sy }
}

function openNodeDetails(nodeId: string) {
  const node = nodeById.value.get(nodeId)
  if (node) requestSkillDescription(node)
  if (selectedId.value === nodeId && detailDrawerOpen.value) {
    selectedId.value = ''
    detailDrawerOpen.value = false
    return
  }
  selectedId.value = nodeId
  detailDrawerOpen.value = true
}

function handleJourneyKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  resetInteractionState()
  event.preventDefault()
}

function handleCanvasKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault()
    previewNodeFromKeyboard(1)
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault()
    previewNodeFromKeyboard(-1)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    previewNodeFromKeyboard(0, event.key === 'Home' ? 0 : projectedVisibleNodes().length - 1)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    if (!hoverTipId.value) previewNodeFromKeyboard(1)
    if (hoverTipId.value) openNodeDetails(hoverTipId.value)
    event.preventDefault()
    return
  }
}

function handleClick(event: MouseEvent) {
  if (performance.now() < suppressClickUntil) {
    suppressClickUntil = 0
    return
  }
  const pos = pointerPosition(event)
  const hit = hitTest(pos.x, pos.y)
  hideNodeHoverTip(true)
  if (!hit) {
    selectedId.value = ''
    selectedCategories.value = []
    detailDrawerOpen.value = false
    return
  }
  openNodeDetails(hit.id)
}

function handleWheel(event: WheelEvent) {
  event.preventDefault()
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + (event.deltaY > 0 ? -0.08 : 0.08)))
}

function clearPlaybackTimer() {
  if (!playbackTimer) return
  window.clearTimeout(playbackTimer)
  playbackTimer = null
}

function clearSelectionDelay() {
  if (!clearSelectionTimer) return
  window.clearTimeout(clearSelectionTimer)
  clearSelectionTimer = null
}

function stopPlayback() {
  clearPlaybackTimer()
  playing.value = false
}

function playNode(index: number) {
  const node = playbackNodes.value[index]
  if (!node) {
    stopPlayback()
    return
  }
  playbackIndex.value = index
  selectedId.value = node.id
  hoverId.value = ''
}

function scheduleNextNode() {
  clearPlaybackTimer()
  playbackTimer = window.setTimeout(() => {
    const nextIndex = playbackIndex.value + 1
    if (nextIndex >= playbackNodes.value.length) {
      stopPlayback()
      clearSelectionDelay()
      clearSelectionTimer = window.setTimeout(() => {
        selectedId.value = ''
        hoverId.value = ''
        clearSelectionTimer = null
      }, 1000)
      return
    }
    playNode(nextIndex)
    scheduleNextNode()
  }, 150)
}

function togglePlayback() {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (!playbackNodes.value.length) return
  clearSelectionDelay()
  playing.value = true
  playNode(0)
  scheduleNextNode()
}

async function loadJourney(options: { clearData?: boolean; resetInteraction?: boolean } = {}) {
  const generation = ++loadGeneration
  stopPlayback()
  clearSelectionDelay()
  resetSkillDescriptionLoad(generation)
  if (options.resetInteraction) resetInteractionState()
  if (options.clearData) data.value = null
  loading.value = true
  try {
    const nextData = await fetchJourneyGraph()
    if (disposed || generation !== loadGeneration) return generation
    data.value = nextData
  } catch (err: any) {
    if (disposed || generation !== loadGeneration) return generation
    message.error(err?.message || t('journey.loadFailed'))
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false
  }
  return generation
}

function journeyResourcesReady() {
  return resizeListenerInstalled && resizeObserverInstalled && rendererStarted
}

function initializeJourneyResources() {
  updateDrawerWidth()
  addResizeListener()
  attachResizeObserver()
  if (!rendererStarted) startRenderer()
}

async function loadJourneyAndInitialize(options: { clearData?: boolean; resetInteraction?: boolean } = {}) {
  const generation = await loadJourney(options)
  if (disposed || generation !== loadGeneration || journeyResourcesReady()) return
  await nextTick()
  if (disposed || generation !== loadGeneration || journeyResourcesReady()) return
  initializeJourneyResources()
}

async function refreshJourney() {
  const generation = await loadJourney()
  if (disposed || generation !== loadGeneration) return
  const descriptionNodeIds = new Set<string>()
  if (detailDrawerOpen.value && selectedId.value) descriptionNodeIds.add(selectedId.value)
  if (hoverTipId.value) descriptionNodeIds.add(hoverTipId.value)
  const needsSkillDescriptions = [...descriptionNodeIds].some((nodeId) => {
    const node = nodeById.value.get(nodeId)
    return node && !isMemoryNode(node)
  })
  if (needsSkillDescriptions) await ensureSkillDescriptionsLoaded(generation)
}

function stopRenderer() {
  if (!rendererStarted) return
  cancelAnimationFrame(raf)
  raf = 0
  rendererStarted = false
}

function startRenderer() {
  stopRenderer()
  resizeCanvas()
  raf = requestAnimationFrame(draw)
  rendererStarted = true
}

onMounted(() => {
  window.addEventListener('keydown', handleJourneyKeydown)
  void loadJourneyAndInitialize()
})

onBeforeUnmount(() => {
  disposed = true
  loadGeneration += 1
  window.removeEventListener('keydown', handleJourneyKeydown)
  stopRenderer()
  clearPlaybackTimer()
  clearSelectionDelay()
  clearHoverTipTimer()
  removeResizeListener()
  detachResizeObserver()
  activePointers.clear()
  ctx = null
})

watch(
  () => profilesStore.activeProfileName || 'default',
  (profile, previousProfile) => {
    if (profile === previousProfile) return
    void loadJourneyAndInitialize({ clearData: true, resetInteraction: true })
  },
)

watch(sceneNodes, () => {
  if (selectedId.value && !nodeById.value.has(selectedId.value)) {
    selectedId.value = ''
    detailDrawerOpen.value = false
  }
  if (hoverTipId.value && !nodeById.value.has(hoverTipId.value)) hideNodeHoverTip(true)
  const availableCategories = new Set(sceneNodes.value.map(node => node.category || 'general'))
  const retainedCategories = selectedCategories.value.filter(category => availableCategories.has(category))
  if (retainedCategories.length !== selectedCategories.value.length) {
    selectedCategories.value = retainedCategories
  }
})
</script>

<template>
  <div class="journey-view">
    <header class="page-header journey-view__header">
      <h2 class="header-title">{{ t('journey.title') }}</h2>
    </header>

    <div class="journey-view__content">
      <div class="journey-panel">
        <div class="journey-toolbar">
          <div class="node-kind-legend" :aria-label="t('journey.nodeKinds')">
            <span class="node-kind-legend__item">
              <i class="node-kind-marker node-kind-marker--skill node-kind-marker--circle" aria-hidden="true" />
              {{ t('journey.skills') }}
            </span>
            <span class="node-kind-legend__item">
              <i class="node-kind-marker node-kind-marker--memory node-kind-marker--diamond" aria-hidden="true" />
              {{ t('journey.memories') }}
            </span>
          </div>
          <NButton
            size="small"
            :disabled="!nodes.length"
            :aria-label="playing ? t('journey.pause') : t('journey.play')"
            :title="playing ? t('journey.pause') : t('journey.play')"
            @click="togglePlayback"
          >
            <span class="playback-icon" :class="{ playing }" aria-hidden="true" />
          </NButton>
          <NButton size="small" :loading="loading" @click="refreshJourney">{{ t('journey.refresh') }}</NButton>
        </div>

        <NSpin :show="loading && !data" class="journey-spin">
          <main class="galaxy-layout">
            <section ref="canvasWrapRef" class="galaxy-canvas-wrap">
              <canvas
                ref="canvasRef"
                class="galaxy-canvas"
                tabindex="0"
                role="group"
                :aria-label="canvasAriaLabel"
                @keydown="handleCanvasKeydown"
                @pointerdown="handlePointerDown"
                @pointermove="handlePointerMove"
                @pointerup="handlePointerUp"
                @pointercancel="handlePointerUp"
                @pointerleave="handlePointerLeave"
                @click="handleClick"
                @wheel="handleWheel"
              />
              <Transition name="journey-tooltip">
                <div
                  v-if="hoverTipNode"
                  class="journey-node-tooltip"
                  role="tooltip"
                  :style="hoverTipStyle"
                >
                  <div class="journey-node-tooltip__name">{{ hoverTipTitle }}</div>
                  <div v-if="hoverTipDescription" class="journey-node-tooltip__description">
                    {{ hoverTipDescription }}
                  </div>
                </div>
              </Transition>
              <div class="galaxy-hud">
                <span>{{ data?.profile || '-' }}</span>
                <span>{{ visibleSceneNodes.length }} {{ t('journey.nodes') }}</span>
                <span>{{ visibleEdges.length }} {{ t('journey.edges') }}</span>
              </div>
              <div v-if="categoryStats.length" class="category-meter">
                <div class="category-bar" role="group" :aria-label="t('journey.categorySelection')">
                  <button
                    v-for="stat in categoryStats"
                    :key="stat.category"
                    type="button"
                    class="category-bar-segment"
                    :class="{
                      active: emphasizedCategorySet.has(stat.category),
                      selected: selectedCategorySet.has(stat.category),
                    }"
                    :style="{ '--category-color': stat.color, flexGrow: stat.count }"
                    :data-category="stat.category"
                    :aria-label="`${stat.label} ${stat.count} / ${Math.round((stat.count / visibleNodeCount) * 100)}%`"
                    :aria-pressed="selectedCategorySet.has(stat.category)"
                    @mouseenter="hoverCategory = stat.category"
                    @mouseleave="hoverCategory = ''"
                    @click="toggleCategorySelection(stat.category)"
                  />
                </div>
                <div class="category-legend" role="group" :aria-label="t('journey.categorySelection')">
                  <button
                    v-for="stat in categoryStats"
                    :key="stat.category"
                    type="button"
                    :class="{
                      active: emphasizedCategorySet.has(stat.category),
                      selected: selectedCategorySet.has(stat.category),
                    }"
                    :data-category="stat.category"
                    :aria-pressed="selectedCategorySet.has(stat.category)"
                    @mouseenter="hoverCategory = stat.category"
                    @mouseleave="hoverCategory = ''"
                    @click="toggleCategorySelection(stat.category)"
                  >
                    <i :style="{ backgroundColor: stat.color }" />
                    {{ stat.label }} {{ stat.count }} / {{ Math.round((stat.count / visibleNodeCount) * 100) }}%
                  </button>
                </div>
              </div>
            </section>
          </main>
        </NSpin>

        <NDrawer v-model:show="detailDrawerOpen" :width="drawerWidth" placement="right">
          <NDrawerContent v-if="selectedNode" class="journey-detail-drawer" :native-scrollbar="false" closable>
            <template #header>
              <div class="drawer-title-row">
                <span>{{ detailTitle(selectedNode) }}</span>
                <NTag size="small" :type="selectedNode.kind === 'memory' ? 'info' : 'success'" :bordered="false">
                  {{ selectedNode.kind }}
                </NTag>
              </div>
            </template>

            <div v-if="isMemoryNode(selectedNode) && memoryText(selectedNode)" class="memory-card">
              <span class="detail-card-label">{{ t('journey.memories') }}</span>
              <p>{{ memoryText(selectedNode) }}</p>
            </div>

            <div v-if="selectedSkillDescription" class="memory-card">
              <span class="detail-card-label">{{ t('journey.description') }}</span>
              <p>{{ selectedSkillDescription }}</p>
            </div>

            <div class="detail-card">
              <span class="detail-card-label">ID</span>
              <code>{{ selectedNode.id }}</code>
            </div>

            <div class="detail-grid">
              <div class="detail-item">
                <span>{{ t('journey.category') }}</span>
                <strong>{{ selectedNode.category || '-' }}</strong>
              </div>
              <div class="detail-item">
                <span>{{ t('journey.useCount') }}</span>
                <strong>{{ selectedNode.useCount ?? 0 }}</strong>
              </div>
              <div class="detail-item">
                <span>{{ t('journey.createdBy') }}</span>
                <strong>{{ selectedNode.createdBy || '-' }}</strong>
              </div>
              <div class="detail-item">
                <span>{{ t('journey.timestamp') }}</span>
                <strong>{{ formatTime(selectedNode.timestamp) }}</strong>
              </div>
            </div>

            <NTag v-if="selectedNode.pinned" size="small" type="warning" :bordered="false">{{ t('journey.pinned') }}</NTag>
          </NDrawerContent>
        </NDrawer>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.journey-view {
  height: calc(100 * var(--vh));
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.journey-view__header {
  flex: 0 0 auto;
}

.journey-view__content {
  flex: 1;
  min-height: 0;
  padding: 16px 20px 20px;
}

@media (max-width: $breakpoint-mobile) {
  .journey-view__content {
    padding: 12px;
  }
}

.journey-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.journey-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding-bottom: 12px;
}

.node-kind-legend {
  display: inline-flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  margin-right: auto;
  color: $text-secondary;
  font-size: 12px;
}

.node-kind-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}

.node-kind-marker {
  width: 10px;
  height: 10px;
  display: inline-block;
  flex: 0 0 auto;
  background: #4f8cff;
  box-shadow: 0 0 0 2px color-mix(in srgb, #4f8cff 20%, transparent);
}

.node-kind-marker--circle {
  border-radius: 50%;
}

.node-kind-marker--diamond {
  border-radius: 2px;
  background: #6ba3d6;
  box-shadow: 0 0 0 2px color-mix(in srgb, #6ba3d6 24%, transparent);
  transform: rotate(45deg);
}

.playback-icon {
  width: 0;
  height: 0;
  display: inline-block;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 10px solid currentcolor;

  &.playing {
    width: 10px;
    height: 12px;
    border: 0;
    background:
      linear-gradient(currentcolor, currentcolor) left center / 3px 12px no-repeat,
      linear-gradient(currentcolor, currentcolor) right center / 3px 12px no-repeat;
  }
}

.journey-spin {
  flex: 1;
  height: 100%;
  min-height: 0;

  :deep(.n-spin-container),
  :deep(.n-spin-content) {
    height: 100%;
    min-height: 0;
  }
}

.galaxy-layout {
  height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
  background:
    radial-gradient(circle at 50% 35%, rgba(var(--accent-info-rgb), 0.12), transparent 36%),
    linear-gradient(180deg, color-mix(in srgb, $bg-primary 88%, #000 12%), $bg-primary);
}

.galaxy-canvas-wrap {
  position: relative;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.galaxy-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;

  &:focus-visible {
    outline: 2px solid $text-primary;
    outline-offset: -2px;
  }

  &:active {
    cursor: grabbing;
  }
}

.journey-node-tooltip {
  position: absolute;
  z-index: 5;
  width: max-content;
  max-width: min(320px, calc(100% - 16px));
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, $border-color 82%, transparent);
  border-radius: $radius-sm;
  background: color-mix(in srgb, $bg-primary 94%, transparent);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
  color: $text-primary;
  pointer-events: none;
  backdrop-filter: blur(12px);
}

.journey-node-tooltip__name {
  max-width: 100%;
  overflow: hidden;
  color: inherit;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.journey-node-tooltip__description {
  display: -webkit-box;
  margin-top: 4px;
  overflow: hidden;
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.journey-tooltip-enter-active,
.journey-tooltip-leave-active {
  transition: opacity 0.12s ease;
}

.journey-tooltip-enter-from,
.journey-tooltip-leave-to {
  opacity: 0;
}

.galaxy-hud {
  position: absolute;
  left: 16px;
  bottom: 16px;
  display: flex;
  gap: 10px;
  color: $text-secondary;
  font-size: 12px;
  pointer-events: none;

  span {
    border: 1px solid color-mix(in srgb, $border-color 70%, transparent);
    border-radius: 999px;
    padding: 5px 9px;
    background: color-mix(in srgb, $bg-primary 72%, transparent);
    backdrop-filter: blur(10px);
  }
}

.category-meter {
  position: absolute;
  top: 14px;
  left: 16px;
  right: 16px;
  display: grid;
  gap: 7px;
  pointer-events: auto;
}

.category-bar {
  position: relative;
  display: flex;
  height: 24px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  &::before {
    position: absolute;
    top: 8px;
    right: 0;
    bottom: 8px;
    left: 0;
    border: 1px solid color-mix(in srgb, $border-color 72%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, $bg-primary 76%, transparent);
    box-shadow: 0 0 18px rgba(var(--accent-info-rgb), 0.12);
    content: '';
  }

  button {
    position: relative;
    z-index: 1;
    display: block;
    min-width: 24px;
    align-self: stretch;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
    transition: flex-grow 0.2s ease;

    &::before {
      position: absolute;
      top: 8px;
      right: 0;
      bottom: 8px;
      left: 0;
      background: var(--category-color);
      content: '';
      transition: filter 0.2s ease, box-shadow 0.2s ease;
    }

    &:first-child::before {
      border-radius: 999px 0 0 999px;
    }

    &:last-child::before {
      border-radius: 0 999px 999px 0;
    }

    &.active::before {
      filter: brightness(1.25);
    }

    &.selected::before {
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.9);
      filter: brightness(1.3) saturate(1.15);
    }

    &:focus-visible {
      outline: 2px solid $text-primary;
      outline-offset: -2px;
    }
  }
}

.category-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: $text-secondary;
  font-size: 11px;

  button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 7px;
    border: 1px solid color-mix(in srgb, $border-color 68%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, $bg-primary 74%, transparent);
    color: inherit;
    font: inherit;
    backdrop-filter: blur(10px);
    cursor: pointer;
    transition: border-color 0.2s ease, color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;

    &.active {
      color: $text-primary;
      border-color: rgba(var(--accent-info-rgb), 0.42);
      background: rgba(var(--accent-info-rgb), 0.1);
    }

    &.selected {
      color: $text-primary;
      font-weight: 600;
      border-color: rgba(var(--accent-info-rgb), 0.95);
      background: rgba(var(--accent-info-rgb), 0.3);
      box-shadow: 0 0 0 2px rgba(var(--accent-info-rgb), 0.34), 0 0 14px rgba(var(--accent-info-rgb), 0.22);
    }

    &:focus-visible {
      outline: 2px solid $accent-primary;
      outline-offset: 2px;
    }
  }

  i {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 999px;
  }
}

.drawer-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;

  span:first-child {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }
}

.journey-detail-drawer {
  :deep(.n-drawer-body-content-wrapper) {
    display: grid;
    align-content: start;
    gap: 14px;
  }
}

.detail-card {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.04);

  code {
    color: $text-primary;
    font-size: 12px;
    line-height: 1.5;
    white-space: normal;
    overflow-wrap: anywhere;
  }
}

.memory-card {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, $border-color 82%, transparent);
  border-radius: $radius-sm;
  background:
    linear-gradient(180deg, rgba(var(--accent-info-rgb), 0.08), transparent),
    $bg-secondary;

  p {
    margin: 0;
    color: $text-primary;
    font-size: 13px;
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}

.detail-card-label,
.detail-item span {
  color: $text-muted;
  font-size: 11px;
  line-height: 1.2;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.detail-item {
  display: grid;
  gap: 5px;
  min-height: 72px;
  padding: 12px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: $bg-secondary;

  strong {
    align-self: end;
    color: $text-primary;
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
}

@media (max-width: 900px) {
  .galaxy-layout {
    grid-template-columns: 1fr;
  }
}
</style>
