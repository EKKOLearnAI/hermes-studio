<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchJourneyGraph, type JourneyGraphResponse, type JourneyMemory, type JourneyNode } from '@/api/hermes/journey'
import { useTheme } from '@/composables/useTheme'

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

const data = ref<JourneyGraphResponse | null>(null)
const loading = ref(false)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const canvasWrapRef = ref<HTMLElement | null>(null)
const selectedId = ref('')
const hoverId = ref('')
const hoverCategory = ref('')
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
      radius: node.kind === 'memory' ? 4 : Math.min(13, 5 + Math.sqrt(node.useCount || 0) * 1.7),
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
  const stats = new Map<string, { category: string; color: string; count: number }>()
  for (const node of visibleSceneNodes.value) {
    const category = node.category || t('journey.noCategory')
    const current = stats.get(category)
    if (current) {
      current.count += 1
    } else {
      stats.set(category, {
        category,
        color: node.color,
        count: 1,
      })
    }
  }
  return [...stats.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
})
const visibleNodeCount = computed(() => Math.max(1, visibleSceneNodes.value.length))

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
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  drawBackground()

  const projected = visibleSceneNodes.value.map(projectNode).filter(node => node.visible)
  const projectedById = new Map(projected.map(node => [node.id, node]))
  const activeId = hoverId.value || selectedId.value
  const activeNeighbors = new Set<string>()

  for (const edge of visibleEdges.value) {
    if (edge.source === activeId) activeNeighbors.add(edge.target)
    if (edge.target === activeId) activeNeighbors.add(edge.source)
  }

  drawEdges(projectedById, activeId, activeNeighbors, now)
  projected
    .sort((a, b) => a.depth - b.depth)
    .forEach(node => drawNode(node, activeId, activeNeighbors, now))

  raf = requestAnimationFrame(draw)
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

function drawEdges(projectedById: Map<string, ProjectedNode>, activeId: string, activeNeighbors: Set<string>, now: number) {
  if (!ctx) return
  ctx.save()
  const pulse = 0.5 + Math.sin(now * 0.012) * 0.5
  for (const edge of visibleEdges.value) {
    const source = projectedById.get(edge.source)
    const target = projectedById.get(edge.target)
    if (!source || !target) continue
    const active = !!activeId && (edge.source === activeId || edge.target === activeId)
    const categoryActive = !!hoverCategory.value && (source.category === hoverCategory.value || target.category === hoverCategory.value)
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

function drawNode(node: ProjectedNode, activeId: string, activeNeighbors: Set<string>, now: number) {
  if (!ctx) return
  const active = node.id === activeId
  const nearby = activeNeighbors.has(node.id)
  const categoryActive = !!hoverCategory.value && node.category === hoverCategory.value
  const hasFocus = !!activeId || !!hoverCategory.value
  const alpha = active || nearby || categoryActive || !hasFocus ? 1 : 0.32
  const pulse = active ? 0.5 + Math.sin(now * 0.005) * 0.5 : 0
  const glow = active ? 20 + pulse * 24 : node.createdBy === 'agent' ? 12 : node.pinned ? 10 : 0
  const nodeBackdrop = isDark.value ? '#1a1a1a' : '#fafafa'

  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = nodeBackdrop
  ctx.beginPath()
  ctx.arc(node.sx, node.sy, Math.max(0, node.size - 0.25), 0, Math.PI * 2)
  ctx.fill()

  ctx.globalAlpha = alpha
  if (glow) {
    ctx.shadowColor = node.color
    ctx.shadowBlur = glow
  }
  ctx.fillStyle = node.color
  ctx.beginPath()
  ctx.arc(node.sx, node.sy, node.size, 0, Math.PI * 2)
  ctx.fill()

  if (node.pinned || active) {
    ctx.shadowBlur = 0
    ctx.strokeStyle = active ? 'rgba(255,255,255,0.9)' : 'rgba(255, 190, 90, 0.85)'
    ctx.lineWidth = active ? 2 : 1.4
    ctx.beginPath()
    ctx.arc(node.sx, node.sy, node.size + 5, 0, Math.PI * 2)
    ctx.stroke()
  }

  if (active) {
    ctx.shadowBlur = 0
    ctx.globalAlpha = 0.28 + pulse * 0.32
    ctx.strokeStyle = node.color
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(node.sx, node.sy, node.size + 10 + pulse * 14, 0, Math.PI * 2)
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

function hitTest(x: number, y: number): ProjectedNode | null {
  const projected = visibleSceneNodes.value.map(projectNode).filter(node => node.visible)
  let best: ProjectedNode | null = null
  for (const node of projected) {
    const dx = x - node.sx
    const dy = y - node.sy
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance <= node.size + 8 && (!best || node.depth > best.depth)) best = node
  }
  return best
}

function pointerPosition(event: MouseEvent | PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = canvasRef.value?.getBoundingClientRect()
  return { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) }
}

function handlePointerDown(event: PointerEvent) {
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (activePointers.size === 2) {
    const pointers = [...activePointers.values()]
    pinchDistance = pointerDistance(pointers[0], pointers[1])
    pinchZoom = zoom
    dragging = false
  } else {
    dragging = true
  }
  lastX = event.clientX
  lastY = event.clientY
  canvasRef.value?.setPointerCapture(event.pointerId)
}

function handlePointerMove(event: PointerEvent) {
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  }
  const pos = pointerPosition(event)
  const hit = hitTest(pos.x, pos.y)
  hoverId.value = hit?.id || ''

  if (activePointers.size >= 2) {
    const pointers = [...activePointers.values()]
    const distance = pointerDistance(pointers[0], pointers[1])
    if (pinchDistance > 0) {
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchZoom * (distance / pinchDistance)))
    }
    return
  }

  if (!dragging) return
  const dx = event.clientX - lastX
  const dy = event.clientY - lastY
  rotationY += dx * 0.006
  rotationX = Math.max(-1.2, Math.min(1.2, rotationX + dy * 0.006))
  lastX = event.clientX
  lastY = event.clientY
}

function handlePointerUp(event: PointerEvent) {
  activePointers.delete(event.pointerId)
  if (activePointers.size === 1) {
    const pointer = [...activePointers.values()][0]
    lastX = pointer.x
    lastY = pointer.y
    dragging = true
  } else {
    dragging = false
    pinchDistance = 0
  }
  canvasRef.value?.releasePointerCapture(event.pointerId)
}

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function handleClick(event: MouseEvent) {
  const pos = pointerPosition(event)
  const hit = hitTest(pos.x, pos.y)
  selectedId.value = hit?.id || ''
  detailDrawerOpen.value = !!hit
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

async function loadJourney() {
  stopPlayback()
  clearSelectionDelay()
  loading.value = true
  try {
    data.value = await fetchJourneyGraph()
    selectedId.value = ''
    hoverId.value = ''
    hoverCategory.value = ''
    playbackIndex.value = -1
  } catch (err: any) {
    message.error(err?.message || t('journey.loadFailed'))
  } finally {
    loading.value = false
  }
}

function startRenderer() {
  cancelAnimationFrame(raf)
  resizeCanvas()
  raf = requestAnimationFrame(draw)
}

onMounted(async () => {
  await loadJourney()
  await nextTick()
  updateDrawerWidth()
  window.addEventListener('resize', updateDrawerWidth)
  resizeObserver = new ResizeObserver(resizeCanvas)
  if (canvasWrapRef.value) resizeObserver.observe(canvasWrapRef.value)
  startRenderer()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  clearPlaybackTimer()
  clearSelectionDelay()
  window.removeEventListener('resize', updateDrawerWidth)
  resizeObserver?.disconnect()
})

watch(sceneNodes, () => {
  if (selectedId.value && !nodeById.value.has(selectedId.value)) selectedId.value = ''
})
</script>

<template>
  <div class="journey-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ t('journey.title') }}</h2>
      </div>
      <div class="header-actions">
        <NButton
          size="small"
          :disabled="!nodes.length"
          :aria-label="playing ? t('journey.pause') : t('journey.play')"
          :title="playing ? t('journey.pause') : t('journey.play')"
          @click="togglePlayback"
        >
          <span class="playback-icon" :class="{ playing }" aria-hidden="true" />
        </NButton>
        <NButton size="small" :loading="loading" @click="loadJourney">{{ t('journey.refresh') }}</NButton>
      </div>
    </header>

    <NSpin :show="loading && !data" class="journey-spin">
      <main class="galaxy-layout">
        <section ref="canvasWrapRef" class="galaxy-canvas-wrap">
          <canvas
            ref="canvasRef"
            class="galaxy-canvas"
            @pointerdown="handlePointerDown"
            @pointermove="handlePointerMove"
            @pointerup="handlePointerUp"
            @pointercancel="handlePointerUp"
            @click="handleClick"
            @wheel="handleWheel"
          />
          <div class="galaxy-hud">
            <span>{{ data?.profile || '-' }}</span>
            <span>{{ visibleSceneNodes.length }} {{ t('journey.nodes') }}</span>
            <span>{{ visibleEdges.length }} {{ t('journey.edges') }}</span>
          </div>
          <div v-if="categoryStats.length" class="category-meter">
            <div class="category-bar" aria-hidden="true">
              <span
                v-for="stat in categoryStats"
                :key="stat.category"
                :class="{ active: hoverCategory === stat.category }"
                :style="{ backgroundColor: stat.color, flexGrow: stat.count }"
                @mouseenter="hoverCategory = stat.category"
                @mouseleave="hoverCategory = ''"
              />
            </div>
            <div class="category-legend">
              <span
                v-for="stat in categoryStats"
                :key="stat.category"
                :class="{ active: hoverCategory === stat.category }"
                @mouseenter="hoverCategory = stat.category"
                @mouseleave="hoverCategory = ''"
              >
                <i :style="{ backgroundColor: stat.color }" />
                {{ stat.category }} {{ stat.count }} / {{ Math.round((stat.count / visibleNodeCount) * 100) }}%
              </span>
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
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.journey-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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

  &:active {
    cursor: grabbing;
  }
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
  display: flex;
  height: 8px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, $border-color 72%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, $bg-primary 76%, transparent);
  box-shadow: 0 0 18px rgba(var(--accent-info-rgb), 0.12);

  span {
    display: block;
    height: 100%;
    align-self: stretch;
    min-width: 3px;
    transition: flex-grow 0.2s ease, filter 0.2s ease;

    &.active {
      min-width: 10px;
      filter: brightness(1.25);
    }
  }
}

.category-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: $text-secondary;
  font-size: 11px;

  span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 7px;
    border: 1px solid color-mix(in srgb, $border-color 68%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, $bg-primary 74%, transparent);
    backdrop-filter: blur(10px);
    cursor: default;

    &.active {
      color: $text-primary;
      border-color: rgba(var(--accent-info-rgb), 0.42);
      background: rgba(var(--accent-info-rgb), 0.1);
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
