<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { NModal, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (e: 'confirm', dataUrl: string): void
  (e: 'close'): void
}>()

const image = ref<HTMLImageElement | null>(null)
const imageSrc = ref('')
const offsetX = ref(0)
const offsetY = ref(0)
const zoom = ref(1)
const minZoom = ref(0.1)
const maxZoom = ref(3)
const dragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
const dragStartOffsetX = ref(0)
const dragStartOffsetY = ref(0)
const fileInput = ref<HTMLInputElement>()

function openFilePicker() {
  fileInput.value?.click()
}

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    alert(t('chat.imageTooLarge'))
    return
  }
  loadImage(file)
}

function loadImage(file: File) {
  const reader = new FileReader()
  reader.onload = () => {
    imageSrc.value = reader.result as string
    const img = new Image()
    img.onload = () => {
      image.value = img
      const minFit = Math.min(256 / img.width, 256 / img.height)
      minZoom.value = Math.max(0.05, minFit * 0.3)
      maxZoom.value = Math.min(8, Math.max(3, minFit * 10))
      zoom.value = Math.max(minFit * 1.5, minZoom.value)
      offsetX.value = 0
      offsetY.value = 0
    }
    img.src = imageSrc.value
  }
  reader.readAsDataURL(file)
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const step = (maxZoom.value - minZoom.value) * 0.03
  if (e.deltaY < 0) {
    zoom.value = Math.min(maxZoom.value, zoom.value + step)
  } else {
    zoom.value = Math.max(minZoom.value, zoom.value - step)
  }
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  dragging.value = true
  dragStartX.value = e.clientX
  dragStartY.value = e.clientY
  dragStartOffsetX.value = offsetX.value
  dragStartOffsetY.value = offsetY.value
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  offsetX.value = dragStartOffsetX.value + (e.clientX - dragStartX.value)
  offsetY.value = dragStartOffsetY.value + (e.clientY - dragStartY.value)
}

function onPointerUp() {
  dragging.value = false
}

function confirm() {
  if (!image.value) return
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const containerSize = 256
  const scale = zoom.value
  const imgW = image.value.width * scale
  const imgH = image.value.height * scale
  const centerX = containerSize / 2 + offsetX.value
  const centerY = containerSize / 2 + offsetY.value
  ctx.beginPath()
  ctx.arc(containerSize / 2, containerSize / 2, containerSize / 2, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(image.value, centerX - imgW / 2, centerY - imgH / 2, imgW, imgH)
  emit('confirm', canvas.toDataURL('image/png'))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  if (e.key === 'Enter' && image.value) confirm()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <NModal :show="show" @mask-click="emit('close')">
    <div class="crop-dialog">
      <div class="crop-header">{{ t('chat.cropAvatar') }}</div>
      <div v-if="!image" class="crop-empty" @click="openFilePicker">
        <div class="crop-empty-icon">📷</div>
        <div>{{ t('chat.clickToSelectImage') }}</div>
        <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onFileChange" />
      </div>
      <div v-else class="crop-body">
        <div
          class="crop-container"
          @wheel="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
        >
          <img
            :src="imageSrc"
            class="crop-image"
            :style="{
              width: image.width * zoom + 'px',
              height: image.height * zoom + 'px',
              transform: `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`,
            }"
            draggable="false"
          />
          <div class="crop-circle" />
        </div>
        <div class="crop-controls">
          <span class="crop-zoom-label">{{ Math.round(zoom * 100) }}%</span>
          <input
            v-model.number="zoom"
            type="range"
            :min="minZoom"
            :max="maxZoom"
            :step="(maxZoom - minZoom) / 200"
            class="crop-slider"
          />
        </div>
        <div class="crop-hint">{{ t('chat.dragToPosition') }}</div>
        <div class="crop-actions">
          <NButton @click="emit('close')">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" @click="confirm">{{ t('common.confirm') }}</NButton>
        </div>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
.crop-dialog {
  background: var(--bg-secondary, #1a1a2e);
  border-radius: 12px;
  width: 360px;
  padding: 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
.crop-header {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #fff);
  margin-bottom: 16px;
  text-align: center;
}
.crop-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px;
  cursor: pointer;
  color: var(--text-muted, #888);
  border: 2px dashed var(--border-color, #333);
  border-radius: 8px;
  transition: border-color 0.2s;
  &:hover { border-color: var(--accent-primary, #4f8cff); }
}
.crop-empty-icon { font-size: 48px; }
.crop-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.crop-container {
  position: relative;
  width: 256px;
  height: 256px;
  margin: 0 auto;
  overflow: hidden;
  border-radius: 8px;
  background: #000;
  cursor: grab;
  touch-action: none;
  &:active { cursor: grabbing; }
}
.crop-image {
  position: absolute;
  top: 50%;
  left: 50%;
  pointer-events: none;
  user-select: none;
}
.crop-circle {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.crop-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
}
.crop-zoom-label {
  font-size: 12px;
  color: var(--text-muted, #888);
  min-width: 36px;
  text-align: right;
}
.crop-slider {
  flex: 1;
  accent-color: var(--accent-primary, #4f8cff);
}
.crop-hint {
  font-size: 11px;
  color: var(--text-muted, #666);
  text-align: center;
}
.crop-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}
</style>
