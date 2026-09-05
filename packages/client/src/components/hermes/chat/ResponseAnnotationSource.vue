<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatAnnotationsStore, type ResponseAnnotationAnchorRect } from '@/stores/hermes/chat-annotations'
import {
  MAX_RESPONSE_ANNOTATION_SELECTED_TEXT_LENGTH,
  responseAnnotationSourceHash,
  type ResponseAnnotation,
} from '@/utils/chat-response-annotations'
import {
  registerResponseAnnotationSource,
  resolveResponseAnnotationSourceElement,
  resolveResponseAnnotationRange,
  restoreResponseAnnotationRange,
  unregisterResponseAnnotationSource,
} from '@/utils/chat-response-annotation-selection'
import {
  avoidResponseAnnotationMarkerCollisions,
  collectResponseAnnotationTextRects,
  collectVisibleResponseAnnotationRangeRects,
  completeResponseAnnotationVisualLineRect,
  placeResponseAnnotationMarker,
} from '@/utils/chat-response-annotation-geometry'

const props = defineProps<{
  sessionId: string
  messageId: string
  source: string
  enabled: boolean
}>()

const emit = defineEmits<{
  error: [code: string]
}>()

const { t } = useI18n()
const annotationsStore = useChatAnnotationsStore()
const sourceRoot = ref<HTMLElement | null>(null)
const toolbar = ref<HTMLElement | null>(null)
const pendingRange = ref<Range | null>(null)
const pendingRect = ref<ResponseAnnotationAnchorRect | null>(null)
const toolbarAutoFocus = ref(false)
const highlightRects = ref<Record<string, Array<{ left: number; top: number; width: number; height: number }>>>({})
const markerPositions = ref<Record<string, { left: number; top: number }>>({})
const flashing = ref(false)
const sourceRegistryVersion = ref(0)
let resizeObserver: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null
let flashTimer: number | null = null
let geometryFrame: number | null = null

const sourceHash = computed(() => responseAnnotationSourceHash(props.source))
const sessionDraftAnnotations = computed(() => annotationsStore.annotationsForSession(props.sessionId))
function targetsThisSource(annotation: ResponseAnnotation) {
  sourceRegistryVersion.value
  return Boolean(sourceRoot.value && resolveResponseAnnotationSourceElement(annotation) === sourceRoot.value)
}
const draftAnnotations = computed(() => sessionDraftAnnotations.value.filter(targetsThisSource))
const inspectedAnnotations = computed(() => annotationsStore.inspectedSentSessionId === props.sessionId
  ? annotationsStore.inspectedSentAnnotations.filter(targetsThisSource)
  : [])
const visibleAnnotations = computed(() => {
  const byId = new Map<string, ResponseAnnotation>()
  for (const annotation of [...draftAnnotations.value, ...inspectedAnnotations.value]) byId.set(annotation.id, annotation)
  return [...byId.values()]
})

const toolbarStyle = computed(() => {
  const rect = pendingRect.value
  if (!rect) return {}
  const width = toolbar.value?.offsetWidth || 116
  const height = toolbar.value?.offsetHeight || 38
  const padding = 8
  const gap = 8
  const preferredLeft = rect.left + (rect.width - width) / 2
  const left = Math.max(padding, Math.min(preferredLeft, window.innerWidth - width - padding))
  const above = rect.top - height - gap
  const top = above >= padding
    ? above
    : Math.min(window.innerHeight - height - padding, rect.bottom + gap)
  return { left: `${left}px`, top: `${Math.max(padding, top)}px` }
})

function serializableRect(rect: DOMRect): ResponseAnnotationAnchorRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  }
}

function selectionInsideSource(selection: Selection, range: Range): boolean {
  const root = sourceRoot.value
  return Boolean(
    root
    && !selection.isCollapsed
    && root.contains(range.startContainer)
    && root.contains(range.endContainer),
  )
}

function updateSelection(event: Event) {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('[data-response-annotation-toolbar]')) return
  if (!props.enabled || !sourceRoot.value) {
    dismissToolbar()
    return
  }
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    dismissToolbar()
    return
  }
  const range = selection.getRangeAt(0)
  if (!selectionInsideSource(selection, range)) {
    dismissToolbar()
    return
  }
  const resolved = resolveResponseAnnotationRange(sourceRoot.value, range)
  const rect = range.getBoundingClientRect()
  if (
    !resolved
    || resolved.selectedText.length > MAX_RESPONSE_ANNOTATION_SELECTED_TEXT_LENGTH
    || !Number.isFinite(rect.left)
    || rect.width <= 0
    || rect.height <= 0
  ) {
    dismissToolbar()
    return
  }
  pendingRange.value = range.cloneRange()
  pendingRect.value = serializableRect(rect)
  toolbarAutoFocus.value = event instanceof KeyboardEvent
    && event.type === 'keyup'
    && event.shiftKey
    && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
  if (toolbarAutoFocus.value) nextTick(() => toolbar.value?.querySelector('button')?.focus())
}

function dismissToolbar() {
  pendingRange.value = null
  pendingRect.value = null
  toolbarAutoFocus.value = false
}

function annotationId(): string {
  return globalThis.crypto?.randomUUID?.()
    || `annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function addToChat() {
  const root = sourceRoot.value
  const range = pendingRange.value
  const anchorRect = pendingRect.value
  if (!root || !range || !anchorRect) return
  const resolved = resolveResponseAnnotationRange(root, range)
  if (!resolved) {
    emit('error', 'selection_unavailable')
    dismissToolbar()
    return
  }
  const annotation: ResponseAnnotation = {
    id: annotationId(),
    ordinal: draftAnnotations.value.length + 1,
    selectedText: resolved.selectedText,
    comment: null,
    sourceMessageId: props.messageId,
    sourceHash: sourceHash.value,
    start: resolved.start,
    end: resolved.end,
    prefix: resolved.prefix,
    suffix: resolved.suffix,
    files: [],
  }
  const existing = annotationsStore.annotationsForSession(props.sessionId).find(item => (
    item.sourceHash === annotation.sourceHash
    && item.start === annotation.start
    && item.end === annotation.end
    && resolveResponseAnnotationSourceElement(item) === root
  ))
  if (existing) {
    annotationsStore.openEditor(props.sessionId, existing.id, anchorRect)
    window.getSelection()?.removeAllRanges()
    dismissToolbar()
    return
  }
  const error = annotationsStore.addAnnotation(props.sessionId, annotation)
  if (error && error !== 'duplicate') {
    emit('error', error)
    dismissToolbar()
    return
  }
  const stored = annotationsStore.annotationsForSession(props.sessionId)
    .find(item => item.id === annotation.id)
    || annotationsStore.annotationsForSession(props.sessionId).find(item => (
      item.sourceMessageId === annotation.sourceMessageId
      && item.sourceHash === annotation.sourceHash
      && item.start === annotation.start
      && item.end === annotation.end
    ))
  if (stored) annotationsStore.openEditor(props.sessionId, stored.id, anchorRect)
  window.getSelection()?.removeAllRanges()
  dismissToolbar()
  void nextTick(scheduleGeometryUpdate)
}

function updateGeometry() {
  const root = sourceRoot.value
  const annotations = visibleAnnotations.value
  if (!root || annotations.length === 0) {
    highlightRects.value = {}
    markerPositions.value = {}
    return
  }
  const rootRect = root.getBoundingClientRect()
  const textRects = collectResponseAnnotationTextRects(root)
  const nextHighlights: typeof highlightRects.value = {}
  const markerCandidates: Array<{
    id: string
    left: number
    top: number
    direction: -1 | 1
  }> = []
  const markerSize = window.matchMedia?.('(pointer: coarse)')?.matches ? 44 : 28
  for (const annotation of annotations) {
    const range = restoreResponseAnnotationRange(root, annotation.start, annotation.end)
    if (!range) continue
    const rects = collectVisibleResponseAnnotationRangeRects(root, range)
    nextHighlights[annotation.id] = rects.map(rect => ({
      left: rect.left - rootRect.left,
      top: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height,
    }))
    const anchorRect = rects.at(-1)
    if (!anchorRect) continue
    const lineRect = completeResponseAnnotationVisualLineRect(textRects, anchorRect) ?? anchorRect
    const position = placeResponseAnnotationMarker(lineRect, rootRect, {
      viewportWidth: window.innerWidth,
      markerSize,
      gap: 6,
      padding: 8,
      textRects,
    })
    markerCandidates.push({
      id: annotation.id,
      ...position,
      direction: position.left >= lineRect.right - rootRect.left ? 1 : -1,
    })
  }
  highlightRects.value = nextHighlights
  markerPositions.value = avoidResponseAnnotationMarkerCollisions(
    markerCandidates,
    markerSize,
    2,
    {
      minLeft: 8 - rootRect.left,
      maxLeft: window.innerWidth - 8 - markerSize - rootRect.left,
    },
    textRects.map(rect => ({
      left: rect.left - rootRect.left,
      right: rect.right - rootRect.left,
      top: rect.top - rootRect.top,
      bottom: rect.bottom - rootRect.top,
      width: rect.width,
      height: rect.height,
    })),
  )
}

function scheduleGeometryUpdate() {
  if (visibleAnnotations.value.length === 0) {
    highlightRects.value = {}
    markerPositions.value = {}
    return
  }
  if (geometryFrame !== null) return
  const schedule = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16)
  geometryFrame = schedule(() => {
    geometryFrame = null
    updateGeometry()
  })
}

function cancelScheduledGeometryUpdate() {
  if (geometryFrame === null) return
  if (window.cancelAnimationFrame) window.cancelAnimationFrame(geometryFrame)
  else window.clearTimeout(geometryFrame)
  geometryFrame = null
}

function openDraftEditor(annotation: ResponseAnnotation, event: MouseEvent) {
  if (!draftAnnotations.value.some(item => item.id === annotation.id)) return
  const target = event.currentTarget as HTMLElement
  annotationsStore.openEditor(props.sessionId, annotation.id, serializableRect(target.getBoundingClientRect()))
}

function handleSourceNavigation(event: Event) {
  const annotation = (event as CustomEvent<{ annotation?: ResponseAnnotation }>).detail?.annotation
  const root = sourceRoot.value
  if (!annotation || !root || resolveResponseAnnotationSourceElement(annotation) !== root) return
  const range = restoreResponseAnnotationRange(root, annotation.start, annotation.end)
  if (!range) return
  root.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flashing.value = true
  if (flashTimer !== null) window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => { flashing.value = false }, 1600)
  event.preventDefault()
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !pendingRange.value) return
  event.preventDefault()
  dismissToolbar()
}

function handleSourceRegistryChange() {
  sourceRegistryVersion.value += 1
}

function notifySourceContentChanged() {
  window.dispatchEvent(new Event('hermes:response-annotation-sources-changed'))
  void nextTick(scheduleGeometryUpdate)
}

onMounted(() => {
  if (sourceRoot.value) registerResponseAnnotationSource(sourceRoot.value, props.source)
  window.addEventListener('hermes:response-annotation-sources-changed', handleSourceRegistryChange)
  document.addEventListener('mouseup', updateSelection)
  document.addEventListener('touchend', updateSelection)
  document.addEventListener('keyup', updateSelection)
  document.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', scheduleGeometryUpdate)
  document.addEventListener('scroll', scheduleGeometryUpdate, true)
  window.addEventListener('hermes:show-response-annotation-source', handleSourceNavigation)
  if (typeof ResizeObserver !== 'undefined' && sourceRoot.value) {
    resizeObserver = new ResizeObserver(scheduleGeometryUpdate)
    resizeObserver.observe(sourceRoot.value)
  }
  if (typeof MutationObserver !== 'undefined' && sourceRoot.value) {
    mutationObserver = new MutationObserver(notifySourceContentChanged)
    mutationObserver.observe(sourceRoot.value, { childList: true, subtree: true, characterData: true })
  }
  window.dispatchEvent(new Event('hermes:response-annotation-sources-changed'))
  void nextTick(scheduleGeometryUpdate)
})

onBeforeUnmount(() => {
  if (sourceRoot.value) unregisterResponseAnnotationSource(sourceRoot.value)
  window.removeEventListener('hermes:response-annotation-sources-changed', handleSourceRegistryChange)
  document.removeEventListener('mouseup', updateSelection)
  document.removeEventListener('touchend', updateSelection)
  document.removeEventListener('keyup', updateSelection)
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', scheduleGeometryUpdate)
  document.removeEventListener('scroll', scheduleGeometryUpdate, true)
  window.removeEventListener('hermes:show-response-annotation-source', handleSourceNavigation)
  resizeObserver?.disconnect()
  mutationObserver?.disconnect()
  cancelScheduledGeometryUpdate()
  if (flashTimer !== null) window.clearTimeout(flashTimer)
  window.dispatchEvent(new Event('hermes:response-annotation-sources-changed'))
})

watch(
  () => visibleAnnotations.value.map(annotation => `${annotation.id}:${annotation.start}:${annotation.end}:${annotation.ordinal}`).join('|'),
  () => void nextTick(scheduleGeometryUpdate),
)

watch(() => props.source, (source) => {
  if (sourceRoot.value) registerResponseAnnotationSource(sourceRoot.value, source)
  notifySourceContentChanged()
})
</script>

<template>
  <div
    ref="sourceRoot"
    class="response-annotation-source"
    :class="{ 'response-annotation-source--flash': flashing }"
    :data-response-annotation-source="`${messageId}:${sourceHash}`"
    :data-message-id="messageId"
  >
    <slot />

    <span
      v-for="annotation in visibleAnnotations"
      :key="`highlight-${annotation.id}`"
      class="response-annotation-highlight-layer"
      data-testid="response-annotation-highlight"
      aria-hidden="true"
    >
      <span
        v-for="(rect, index) in highlightRects[annotation.id] || []"
        :key="index"
        class="response-annotation-highlight"
        :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
      />
    </span>

    <button
      v-for="annotation in visibleAnnotations"
      v-show="markerPositions[annotation.id]"
      :key="`marker-${annotation.id}`"
      type="button"
      class="response-annotation-marker"
      data-testid="response-annotation-marker"
      data-annotation-ignore
      :aria-label="t('chat.annotations.markerLabel', { index: annotation.ordinal, excerpt: annotation.selectedText.slice(0, 80) })"
      :style="markerPositions[annotation.id]
        ? { left: `${markerPositions[annotation.id].left}px`, top: `${markerPositions[annotation.id].top}px` }
        : undefined"
      @click="openDraftEditor(annotation, $event)"
    >
      {{ annotation.ordinal }}
    </button>
  </div>

  <Teleport to="body">
    <div
      v-if="pendingRange && pendingRect"
      ref="toolbar"
      role="toolbar"
      data-response-annotation-toolbar
      :aria-label="t('chat.annotations.toolbarLabel')"
      class="response-annotation-toolbar"
      :style="toolbarStyle"
      @pointerdown.prevent
    >
      <button type="button" @click="addToChat">
        {{ t('chat.annotations.addToChat') }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.response-annotation-source {
  position: relative;
  min-width: 0;
  transition: box-shadow 180ms ease;
}

.response-annotation-source--flash {
  border-radius: 6px;
  box-shadow: 0 0 0 2px rgba(var(--success-rgb), 0.58);
}

.response-annotation-highlight-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}

.response-annotation-highlight {
  position: absolute;
  border-radius: 2px;
  background: rgba(var(--success-rgb), 0.24);
}

.response-annotation-marker {
  position: absolute;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: var(--text-on-accent);
  background: var(--success);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.response-annotation-marker:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}

.response-annotation-toolbar {
  position: fixed;
  z-index: 1000;
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-card);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.32);
}

.response-annotation-toolbar button {
  min-height: 38px;
  padding: 0 16px;
  border: 0;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.response-annotation-toolbar button:hover,
.response-annotation-toolbar button:focus-visible {
  background: var(--bg-card-hover);
  outline: none;
}

@media (pointer: coarse) {
  .response-annotation-marker {
    width: 44px;
    height: 44px;
  }

  .response-annotation-toolbar button {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .response-annotation-source {
    transition: none;
  }
}
</style>
