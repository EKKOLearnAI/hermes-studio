<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Message, SubagentStream, SubagentStreamEntry, SubagentStreamStatus } from '@/stores/hermes/chat'
import MessageItem from './MessageItem.vue'
import VirtualMessageList from './VirtualMessageList.vue'

const props = defineProps<{
  stream: SubagentStream | null
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const streamListRef = ref<InstanceType<typeof VirtualMessageList> | null>(null)

const streamRevision = computed(() => {
  const stream = props.stream
  if (!stream) return 'empty'
  return `${stream.status}:${stream.entries.map(entry => `${entry.id}:${entry.timestamp}:${entry.text?.length || 0}`).join('|')}`
})

const taskPosition = computed(() => {
  const stream = props.stream
  if (!stream) return ''
  return `${stream.taskIndex + 1}/${Math.max(1, stream.taskCount)}`
})

const streamMessages = computed(() =>
  (props.stream?.entries || [])
    .filter(entry => entry.kind !== 'status')
    .map((entry, index) => entryMessage(entry, index)),
)

const metrics = computed(() => {
  const stream = props.stream
  if (!stream) return []
  const values: Array<{ key: string; value: string }> = []
  if (stream.model) values.push({ key: 'model', value: stream.model })
  if (stream.toolCount != null) values.push({ key: 'tools', value: t('subagent.tools', { count: stream.toolCount }) })
  if (stream.inputTokens != null || stream.outputTokens != null) {
    values.push({
      key: 'tokens',
      value: t('subagent.tokens', {
        input: formatCount(stream.inputTokens || 0),
        output: formatCount(stream.outputTokens || 0),
      }),
    })
  }
  if (stream.durationSeconds != null) values.push({ key: 'duration', value: formatDuration(stream.durationSeconds) })
  return values
})

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}m ${remaining}s`
}

function statusKey(status: SubagentStreamStatus | 'started'): string {
  if (status === 'error') return 'failed'
  return status
}

function statusText(entry?: SubagentStreamEntry): string {
  if (entry?.text && entry.status === 'running') return entry.text
  const status = entry?.status || props.stream?.status || 'running'
  return t(`subagent.${statusKey(status)}`)
}

function entryMessage(entry: SubagentStreamEntry, index: number): Message {
  const common = {
    id: `subagent-stream:${props.stream?.subagentId || 'unknown'}:${entry.id}:${index}`,
    timestamp: entry.timestamp,
  }
  if (entry.kind === 'tool') {
    return {
      ...common,
      role: 'tool',
      content: '',
      toolName: entry.toolName || t('subagent.tool'),
      toolCallId: `subagent-stream-tool:${entry.id}`,
      toolPreview: entry.text,
      toolArgs: entry.toolArgs,
      toolStatus: 'done',
    }
  }
  if (entry.kind === 'thinking') {
    return {
      ...common,
      role: 'assistant',
      content: '',
      reasoning: entry.text || '',
      isStreaming: props.stream?.status === 'running'
        && props.stream.entries[props.stream.entries.length - 1]?.id === entry.id,
    }
  }
  return {
    ...common,
    role: 'assistant',
    content: entry.text || '',
  }
}

watch(streamRevision, () => {
  if (streamListRef.value?.shouldAutoFollowBottom(96) !== false) {
    streamListRef.value?.scrollToBottom({ frames: 2, keepAliveMs: 250 })
  }
})

onMounted(() => {
  streamListRef.value?.scrollToBottom({ frames: 2, keepAliveMs: 250 })
})
</script>

<template>
  <section class="subagent-stream-panel">
    <header class="subagent-stream-header">
      <div class="subagent-stream-heading">
        <div class="subagent-stream-kicker">
          <span class="subagent-live-dot" :class="{ active: stream?.status === 'running' }" aria-hidden="true"></span>
          <span>{{ t('subagent.title') }}</span>
          <span v-if="taskPosition" class="subagent-task-position">{{ taskPosition }}</span>
        </div>
        <div class="subagent-stream-title">{{ stream?.goal || t('subagent.noGoal') }}</div>
        <div v-if="metrics.length" class="subagent-stream-metrics">
          <span v-for="metric in metrics" :key="metric.key">{{ metric.value }}</span>
        </div>
      </div>
      <div class="subagent-header-actions">
        <span v-if="stream" class="subagent-status" :class="`status-${statusKey(stream.status)}`">
          {{ statusText() }}
        </span>
        <button
          type="button"
          class="subagent-close"
          :aria-label="t('subagent.close')"
          :title="t('subagent.close')"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </header>

    <div class="subagent-stream-body">
      <VirtualMessageList
        ref="streamListRef"
        :messages="streamMessages"
        :virtualized="false"
        padding="20px"
        :row-gap="16"
      >
        <template #item="{ message }">
          <MessageItem :message="message" />
        </template>
        <template #empty>
          <div class="subagent-empty">
            <span v-if="stream?.status === 'running'" class="subagent-empty-spinner" aria-hidden="true"></span>
            <span>{{ stream?.status === 'running' ? t('subagent.waiting') : statusText() }}</span>
          </div>
        </template>
      </VirtualMessageList>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.subagent-stream-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: $bg-main-surface;
}

.subagent-stream-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
}

.subagent-stream-heading {
  min-width: 0;
}

.subagent-stream-kicker {
  display: flex;
  align-items: center;
  gap: 7px;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 600;
}

.subagent-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: $text-muted;

  &.active {
    background: var(--accent-primary);
    box-shadow: 0 0 0 4px rgba(var(--accent-primary-rgb), 0.12);
    animation: subagent-pulse 1.6s ease-in-out infinite;
  }
}

.subagent-task-position {
  color: $text-muted;
  font-family: $font-code;
  font-weight: 400;
}

.subagent-stream-title {
  margin-top: 6px;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.subagent-stream-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;

  span {
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(var(--accent-primary-rgb), 0.07);
    color: $text-muted;
    font-family: $font-code;
    font-size: 10px;
  }
}

.subagent-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.subagent-status {
  padding: 3px 8px;
  border-radius: 999px;
  color: $text-secondary;
  background: rgba(var(--accent-primary-rgb), 0.08);
  font-size: 11px;

  &.status-running {
    color: var(--accent-primary);
  }

  &.status-failed,
  &.status-cancelled,
  &.status-interrupted {
    color: $error;
    background: rgba(var(--error-rgb), 0.08);
  }
}

.subagent-close {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: $radius-sm;
  color: $text-muted;
  background: transparent;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    outline: none;
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }

  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }
}

.subagent-stream-body {
  flex: 1;
  min-height: 0;
  display: flex;
  background: $bg-main-surface;
}

.subagent-empty {
  height: 100%;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: $text-muted;
  font-size: 13px;
}

.subagent-empty-spinner {
  width: 14px;
  height: 14px;
  border: 1.5px solid $text-muted;
  border-top-color: transparent;
  border-radius: 50%;
  animation: subagent-spin 0.7s linear infinite;
}

@keyframes subagent-spin {
  to { transform: rotate(360deg); }
}

@keyframes subagent-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

@media (max-width: $breakpoint-mobile) {
  .subagent-stream-header {
    padding: 8px 12px;
  }

  .subagent-status {
    display: none;
  }

  .subagent-stream-body :deep(.virtual-message-list) {
    --virtual-list-padding: 16px 12px 24px !important;
  }
}
</style>
