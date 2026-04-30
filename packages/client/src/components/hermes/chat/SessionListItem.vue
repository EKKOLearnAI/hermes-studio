<script setup lang="ts">
import { NPopconfirm } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Session } from '@/stores/hermes/chat'
import { formatTimestampMs } from '@/shared/session-display'

const props = defineProps<{
  session: Session
  active: boolean
  pinned: boolean
  canDelete: boolean
  streaming?: boolean
}>()

const emit = defineEmits<{
  select: []
  contextmenu: [event: MouseEvent]
  delete: []
}>()

const { t } = useI18n()
</script>

<template>
  <button
    class="session-item"
    :class="{ active }"
    :aria-current="active ? 'page' : undefined"
    @click="emit('select')"
    @contextmenu="emit('contextmenu', $event)"
  >
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
    <NPopconfirm v-if="canDelete" @positive-click="emit('delete')">
      <template #trigger>
        <button class="session-item-delete" @click.stop>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </template>
      {{ t('chat.deleteSession') }}
    </NPopconfirm>
  </button>
</template>
