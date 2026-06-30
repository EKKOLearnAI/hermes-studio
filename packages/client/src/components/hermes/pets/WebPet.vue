<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { usePetsStore } from '@/stores/hermes/pets'
import { usePetStateStore } from '@/stores/hermes/pet-state'
import { useProfilesStore } from '@/stores/hermes/profiles'
import type { ActivePet, WebPetPosition } from '@/api/hermes/pets'
import type { PetState } from '@/api/hermes/pet-state'

const MIN_SCALE = 0.18
const MAX_SCALE = 1.2
const SCALE_STEP = 0.06
const SAVE_DELAY_MS = 350
const STATE_SETTLE_MS = 180
const MIN_STATE_VISIBLE_MS = 520

const route = useRoute()
const petsStore = usePetsStore()
const petStateStore = usePetStateStore()
const profilesStore = useProfilesStore()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
const imageRevision = ref(0)
const position = ref<WebPetPosition>({ x: 0, y: 0 })
const scale = ref(0.33)
const dragging = ref(false)
const resizing = ref(false)
const dragOffset = ref({ x: 0, y: 0 })
const resizeStart = ref({
  pointerX: 0,
  width: 0,
})
const canvasPixelSize = ref({ width: 0, height: 0, dpr: 0 })
const frameIndex = ref(0)
const displayedState = ref<PetState>('idle')
const movementRowOverride = ref('')

let animationTimer: number | null = null
let saveTimer: number | null = null
let stateSwitchTimer: number | null = null
let stateOverrideTimer: number | null = null
let lastStateChangedAt = 0
let activeSpriteKey = ''
let connectedPetProfile: string | null = null

const isLoginPage = computed(() => route.name === 'login')
const pet = computed(() => petsStore.activePet)
const visible = computed(() => !isLoginPage.value && !!pet.value?.enabled && !!image.value)
const frameWidth = computed(() => pet.value?.frameW || 192)
const frameHeight = computed(() => pet.value?.frameH || 208)
const renderedWidth = computed(() => Math.round(frameWidth.value * scale.value))
const renderedHeight = computed(() => Math.round(frameHeight.value * scale.value))

const stateRow = computed(() => {
  const active = pet.value
  if (!active) return 0
  if (movementRowOverride.value) {
    const movementIndex = active.stateRows.indexOf(movementRowOverride.value)
    if (movementIndex >= 0) return movementIndex
  }
  const state = displayedState.value
  const rowName = state === 'run'
    ? 'running'
    : state === 'wave'
      ? 'waving'
      : state === 'jump'
        ? 'jumping'
        : state
  const index = active.stateRows.indexOf(rowName)
  return index >= 0 ? index : 0
})

const shellStyle = computed(() => ({
  left: `${position.value.x}px`,
  top: `${position.value.y}px`,
  width: `${renderedWidth.value}px`,
  height: `${renderedHeight.value}px`,
}))

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampPosition(next: WebPetPosition): WebPetPosition {
  const maxX = Math.max(0, window.innerWidth - renderedWidth.value)
  const maxY = Math.max(0, window.innerHeight - renderedHeight.value)
  return {
    x: Math.round(clamp(next.x, 0, maxX)),
    y: Math.round(clamp(next.y, 0, maxY)),
  }
}

function defaultPosition(): WebPetPosition {
  return clampPosition({
    x: window.innerWidth - renderedWidth.value - 28,
    y: window.innerHeight - renderedHeight.value - 28,
  })
}

function applyPetPreferences(active: ActivePet): void {
  scale.value = clamp(active.scale || 0.33, MIN_SCALE, MAX_SCALE)
  position.value = active.position ? clampPosition(active.position) : defaultPosition()
}

function draw(): void {
  const canvas = canvasRef.value
  const active = pet.value
  const sprite = image.value
  if (!canvas || !active || !sprite) return

  const dpr = window.devicePixelRatio || 1
  const width = renderedWidth.value
  const height = renderedHeight.value
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))
  const previous = canvasPixelSize.value
  if (previous.width !== pixelWidth || previous.height !== pixelHeight || previous.dpr !== dpr) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    canvasPixelSize.value = { width: pixelWidth, height: pixelHeight, dpr }
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(
    sprite,
    frameIndex.value * active.frameW,
    stateRow.value * active.frameH,
    active.frameW,
    active.frameH,
    0,
    0,
    width,
    height,
  )
}

function startAnimation(): void {
  stopAnimation()
  const active = pet.value
  if (!active) return
  const interval = Math.max(80, Math.round(active.loopMs / active.framesPerState))
  animationTimer = window.setInterval(() => {
    frameIndex.value = (frameIndex.value + 1) % active.framesPerState
    draw()
  }, interval)
}

function stopAnimation(): void {
  if (animationTimer != null) {
    window.clearInterval(animationTimer)
    animationTimer = null
  }
}

function scheduleSave(): void {
  if (saveTimer != null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void petsStore.savePreferences({
      scale: scale.value,
      position: position.value,
    })
  }, SAVE_DELAY_MS)
}

function clearStateSwitchTimer(): void {
  if (stateSwitchTimer != null) {
    window.clearTimeout(stateSwitchTimer)
    stateSwitchTimer = null
  }
}

function clearStateOverrideTimer(): void {
  if (stateOverrideTimer != null) {
    window.clearTimeout(stateOverrideTimer)
    stateOverrideTimer = null
  }
}

function applyDisplayedState(next: PetState): void {
  if (displayedState.value === next) return
  movementRowOverride.value = ''
  displayedState.value = next
  lastStateChangedAt = Date.now()
  frameIndex.value = 0
  draw()
}

function overrideDisplayedState(next: PetState, durationMs?: number): void {
  clearStateSwitchTimer()
  clearStateOverrideTimer()
  applyDisplayedState(next)
  if (durationMs) {
    stateOverrideTimer = window.setTimeout(() => {
      stateOverrideTimer = null
      scheduleDisplayedState(petStateStore.state)
    }, durationMs)
  }
}

function stateOverrideDuration(state: PetState): number {
  const active = pet.value
  const loopMs = active?.loopMs || 1100
  if (state === 'jump') return loopMs + 40
  return loopMs
}

function scheduleDisplayedState(next: PetState): void {
  if (stateOverrideTimer != null) return
  if (displayedState.value === next) {
    clearStateSwitchTimer()
    return
  }

  clearStateSwitchTimer()
  const immediate = next === 'failed' || next === 'waiting' || next === 'wave' || next === 'jump'
  const elapsed = Date.now() - lastStateChangedAt
  const delay = immediate ? 0 : Math.max(STATE_SETTLE_MS, MIN_STATE_VISIBLE_MS - elapsed)
  stateSwitchTimer = window.setTimeout(() => {
    stateSwitchTimer = null
    if (petStateStore.state === next) applyDisplayedState(next)
  }, delay)
}

function handlePointerDown(event: PointerEvent): void {
  if (!visible.value || resizing.value) return
  dragging.value = true
  overrideDisplayedState('run')
  movementRowOverride.value = ''
  dragOffset.value = {
    x: event.clientX - position.value.x,
    y: event.clientY - position.value.y,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function handlePointerMove(event: PointerEvent): void {
  if (!dragging.value || resizing.value) return
  const previousX = position.value.x
  position.value = clampPosition({
    x: event.clientX - dragOffset.value.x,
    y: event.clientY - dragOffset.value.y,
  })
  const deltaX = position.value.x - previousX
  if (Math.abs(deltaX) >= 1) {
    movementRowOverride.value = deltaX < 0 ? 'running-left' : 'running-right'
    draw()
  }
  scheduleSave()
}

function handlePointerUp(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  movementRowOverride.value = ''
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  scheduleSave()
  scheduleDisplayedState(petStateStore.state)
}

function handleDoubleClick(): void {
  if (!visible.value) return
  overrideDisplayedState('jump', stateOverrideDuration('jump'))
}

function setScale(next: number): void {
  const before = { ...position.value }
  scale.value = clamp(next, MIN_SCALE, MAX_SCALE)
  position.value = clampPosition(before)
  draw()
  scheduleSave()
}

function handleResizePointerDown(event: PointerEvent): void {
  if (!visible.value) return
  resizing.value = true
  dragging.value = false
  resizeStart.value = {
    pointerX: event.clientX,
    width: renderedWidth.value,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function handleResizePointerMove(event: PointerEvent): void {
  if (!resizing.value) return
  const width = resizeStart.value.width + event.clientX - resizeStart.value.pointerX
  const nextScale = width / frameWidth.value
  scale.value = clamp(nextScale, MIN_SCALE, MAX_SCALE)
  position.value = clampPosition(position.value)
  draw()
  scheduleSave()
}

function handleResizePointerUp(event: PointerEvent): void {
  if (!resizing.value) return
  resizing.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  scheduleSave()
}

function handleWheel(event: WheelEvent): void {
  event.preventDefault()
  setScale(scale.value + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP))
}

function handleResize(): void {
  position.value = pet.value?.position ? clampPosition(position.value) : defaultPosition()
  draw()
  scheduleSave()
}

function shutdownPetConnection(): void {
  petStateStore.disconnect()
  connectedPetProfile = null
}

async function connectPetStateForProfile(profile?: string | null): Promise<void> {
  const nextProfile = profile || profilesStore.activeProfileName || localStorage.getItem('hermes_active_profile_name') || 'default'
  if (connectedPetProfile === nextProfile) return
  shutdownPetConnection()
  connectedPetProfile = nextProfile
  await petStateStore.connect(nextProfile)
}

async function loadForProfile(profile?: string | null): Promise<void> {
  if (isLoginPage.value) return
  shutdownPetConnection()
  const active = await petsStore.loadActivePet()
  if (active?.enabled) await connectPetStateForProfile(profile)
}

watch(
  () => profilesStore.activeProfileName,
  profile => {
    if (!profile || isLoginPage.value) return
    void loadForProfile(profile)
  },
)

watch(isLoginPage, loginPage => {
  if (loginPage) {
    petStateStore.disconnect()
    petsStore.clear()
    return
  }
  void loadForProfile(profilesStore.activeProfileName || localStorage.getItem('hermes_active_profile_name') || 'default')
}, { immediate: true })

watch(pet, active => {
  if (!active) {
    stopAnimation()
    image.value = null
    activeSpriteKey = ''
    shutdownPetConnection()
    return
  }

  const spriteKey = `${active.slug}:${active.spritesheetRevision}`
  applyPetPreferences(active)
  if (active.enabled && !isLoginPage.value) {
    void connectPetStateForProfile()
  }
  if (spriteKey === activeSpriteKey && image.value) {
    draw()
    return
  }

  stopAnimation()
  image.value = null
  activeSpriteKey = spriteKey
  const nextImage = new Image()
  nextImage.onload = () => {
    image.value = nextImage
    imageRevision.value = active.spritesheetRevision
    frameIndex.value = 0
    void nextTick(() => {
      draw()
      startAnimation()
    })
  }
  nextImage.src = active.spritesheetDataUrl
}, { immediate: true })

watch([stateRow, scale], () => draw())

watch(
  () => petStateStore.state,
  state => scheduleDisplayedState(state),
  { immediate: true },
)

onMounted(() => {
  lastStateChangedAt = Date.now()
  window.addEventListener('resize', handleResize)
  window.addEventListener('pagehide', shutdownPetConnection)
  window.addEventListener('beforeunload', shutdownPetConnection)
})

onUnmounted(() => {
  stopAnimation()
  if (saveTimer != null) window.clearTimeout(saveTimer)
  clearStateSwitchTimer()
  clearStateOverrideTimer()
  petStateStore.disconnect()
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('pagehide', shutdownPetConnection)
  window.removeEventListener('beforeunload', shutdownPetConnection)
})
</script>

<template>
  <div
    v-show="visible"
    class="web-pet"
    :class="{ dragging, resizing }"
    :style="shellStyle"
    @pointerdown="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="handlePointerUp"
    @pointercancel="handlePointerUp"
    @wheel="handleWheel"
    @dblclick="handleDoubleClick"
  >
    <canvas ref="canvasRef" class="web-pet-canvas" :aria-label="pet?.displayName || 'Pet'" />
    <button
      type="button"
      class="web-pet-resize"
      aria-label="Resize pet"
      @pointerdown.stop="handleResizePointerDown"
      @pointermove.stop="handleResizePointerMove"
      @pointerup.stop="handleResizePointerUp"
      @pointercancel.stop="handleResizePointerUp"
    >
      <img src="/icons/pet-resize.svg" alt="" draggable="false" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.web-pet {
  position: fixed;
  z-index: 1200;
  cursor: grab;
  user-select: none;
  touch-action: none;
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.24));

  &.dragging {
    cursor: grabbing;
  }

  &.resizing {
    cursor: nwse-resize;
  }
}

.web-pet-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.web-pet-resize {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.74);
  box-shadow:
    0 4px 14px rgba(0, 0, 0, 0.18),
    inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  cursor: nwse-resize;
  opacity: 0;
  transition: opacity 0.14s ease, transform 0.14s ease;

  &:hover {
    opacity: 1;
    transform: translate(-1px, -1px);
  }

  img {
    width: 14px;
    height: 14px;
    display: block;
    opacity: 0.78;
    user-select: none;
    pointer-events: none;
  }
}

.web-pet:hover .web-pet-resize,
.web-pet.resizing .web-pet-resize {
  opacity: 0.92;
}

:global(.dark) .web-pet-resize {
  background: rgba(25, 28, 35, 0.78);
  box-shadow:
    0 4px 14px rgba(0, 0, 0, 0.3),
    inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}
</style>
