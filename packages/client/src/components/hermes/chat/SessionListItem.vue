<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { NPopconfirm, NCheckbox } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Session } from '@/stores/hermes/chat'
import { formatTimestampMs } from '@/shared/session-display'

const props = defineProps<{
  session: Session
  active: boolean
  pinned: boolean
  canDelete: boolean
  streaming?: boolean
  selectable?: boolean
  selected?: boolean
}>()

const emit = defineEmits<{
  select: []
  contextmenu: [event: MouseEvent]
  delete: []
  'toggle-select': []
}>()

const { t } = useI18n()

let longPressTimer: ReturnType<typeof setTimeout> | null = null
const longPressTriggered = ref(false)

function onTouchStart(e: TouchEvent) {
  longPressTriggered.value = false
  longPressTimer = setTimeout(() => {
    longPressTriggered.value = true
    const touch = e.touches[0]
    const syntheticEvent = new MouseEvent('contextmenu', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      bubbles: true,
    })
    emit('contextmenu', syntheticEvent)
  }, 500)
}

function onTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function onTouchMove() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function onClick() {
  if (longPressTriggered.value) {
    longPressTriggered.value = false
    return
  }
  emit('select')
}

onUnmounted(() => {
  if (longPressTimer) clearTimeout(longPressTimer)
})
</script>

<template>
  <button
    class="session-item"
    :class="{ active, 'batch-mode': selectable }"
    :aria-current="active ? 'page' : undefined"
    @click="onClick"
    @contextmenu="emit('contextmenu', $event)"
    @touchstart="onTouchStart"
    @touchend="onTouchEnd"
    @touchmove="onTouchMove"
  >
    <div v-if="selectable" class="session-item-checkbox">
      <NCheckbox :checked="selected" @click.stop="emit('toggle-select')" />
    </div>
    <div class="session-item-content">
      <span class="session-item-title-row">
        <span v-if="pinned" class="session-item-pin" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 17v5" />
            <path d="M5 8l14 0" />
            <path d="M8 3l8 0 0 5 3 5-14 0 3-5z" />
          </svg>
        </span>
        <span class="session-item-title">
          <svg v-if="streaming" class="session-item-streaming" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          {{ session.title }}
        </span>
      </span>
      <span class="session-item-meta">
        <span v-if="session.model" class="session-item-model">{{ session.model }}</span>
        <span class="session-item-time">{{ formatTimestampMs(session.createdAt) }}</span>
      </span>
    </div>
    <NPopconfirm v-if="canDelete && !selectable" @positive-click="emit('delete')">
      <template #trigger>
        <button class="session-item-delete" @click.stop>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </template>
      {{ t('chat.deleteSession') }}
    </NPopconfirm>
  </button>
</template>
