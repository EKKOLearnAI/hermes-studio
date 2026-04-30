<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { NSelect, NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchLogFiles, fetchLogs, type LogEntry } from '@/api/hermes/logs'

const { t } = useI18n()
const message = useMessage()
const logFiles = ref<{ name: string; size: string; modified: string }[]>([])
const selectedLog = ref('agent')
const entries = ref<LogEntry[]>([])
const loading = ref(false)
const lineCount = ref(100)
const levelFilter = ref<string>('')
const searchQuery = ref('')

const logOptions = computed(() =>
  logFiles.value.map(f => ({ label: `${f.name} (${f.size})`, value: f.name })),
)

const levelOptions = computed(() => [
  { label: t('logs.all'), value: '' },
  { label: 'ERROR', value: 'ERROR' },
  { label: 'WARNING', value: 'WARNING' },
  { label: 'INFO', value: 'INFO' },
  { label: 'DEBUG', value: 'DEBUG' },
])

const lineOptions = [
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '200', value: 200 },
  { label: '500', value: 500 },
]

const filteredEntries = computed(() => {
  if (!searchQuery.value) return entries.value
  const q = searchQuery.value.toLowerCase()
  return entries.value.filter(e =>
    e.message.toLowerCase().includes(q) ||
    e.logger.toLowerCase().includes(q) ||
    e.raw.toLowerCase().includes(q),
  )
})

function levelClass(level: string): string {
  switch (level) {
    case 'ERROR': return 'level-error'
    case 'WARNING': return 'level-warning'
    case 'DEBUG': return 'level-debug'
    default: return 'level-info'
  }
}

function formatTime(ts: string): string {
  const match = ts.match(/\d{2}:\d{2}:\d{2}/)
  return match ? match[0] : ts
}

function parseAccessLog(msg: string) {
  const match = msg.match(/"(\w+)\s+(\S+)\s+HTTP\/[^"]+"\s+(\d+)/)
  if (match) return { method: match[1], path: match[2], status: match[3] }
  return null
}

async function loadLogs() {
  loading.value = true
  try {
    const data = await fetchLogs(selectedLog.value, {
      lines: lineCount.value,
      level: levelFilter.value || undefined,
    })
    entries.value = data.filter((e): e is LogEntry => e !== null)
  } catch (e: any) {
    message.error(e.message)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  logFiles.value = await fetchLogFiles()
  await loadLogs()
})
</script>

<template>
  <div class="logs-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('logs.title') }}</h2>
      <div class="header-actions">
        <NSelect
          v-model:value="selectedLog"
          :options="logOptions"
          size="small"
          class="input-md"
          @update:value="loadLogs"
        />
        <NSelect
          :value="levelFilter"
          :options="levelOptions"
          size="small"
          class="input-sm"
          @update:value="(v: string) => { levelFilter = v; loadLogs() }"
        />
        <NSelect
          :value="lineCount"
          :options="lineOptions"
          size="small"
          class="input-sm"
          @update:value="(v: number) => { lineCount = v; loadLogs() }"
        />
        <input
          v-model="searchQuery"
          class="search-input"
          :placeholder="t('logs.searchPlaceholder')"
        />
        <NButton size="small" :loading="loading" @click="loadLogs">{{ t('logs.refresh') }}</NButton>
      </div>
    </header>

    <div class="logs-body">
      <NSpin :show="loading">
        <div v-if="filteredEntries.length === 0 && !loading" class="logs-empty">
          {{ t('logs.noEntries') }}
        </div>
        <div class="log-list">
          <div
            v-for="(entry, idx) in filteredEntries"
            :key="idx"
            class="log-entry"
            :class="levelClass(entry.level)"
          >
            <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
            <span class="log-level" :class="levelClass(entry.level)">{{ entry.level }}</span>
            <span class="log-logger">{{ entry.logger }}</span>
            <template v-if="parseAccessLog(entry.message)">
              <span class="access-method">{{ parseAccessLog(entry.message)!.method }}</span>
              <span class="access-path">{{ parseAccessLog(entry.message)!.path }}</span>
              <span class="access-status" :class="'status-' + (parseAccessLog(entry.message)!.status?.[0] || 'x')">
                {{ parseAccessLog(entry.message)!.status }}
              </span>
            </template>
            <span v-else class="log-message">{{ entry.message }}</span>
          </div>
        </div>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.logs-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.page-header {
  gap: 12px;
  flex-wrap: wrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.search-input {
  padding: 4px 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  font-size: 13px;
  outline: none;
  width: 160px;
  transition: border-color $transition-fast;

  &:focus { border-color: $accent-primary; }
  &::placeholder { color: $text-muted; }
}

.logs-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.logs-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: $text-muted;
  font-size: 13px;
}

.log-list {
  padding: 4px 0;
}

.log-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 20px;
  font-family: $font-code;
  font-size: 12px;
  line-height: 1.6;
  border-left: 2px solid transparent;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.03);
  }

  &.level-error {
    border-left-color: $error;
    .log-message { color: $error; }
  }

  &.level-warning {
    border-left-color: $warning;
    .log-message { color: $warning; }
  }
}

.log-time {
  color: $text-muted;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.log-level {
  flex-shrink: 0;
  font-weight: 600;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 2px;
  min-width: 42px;
  text-align: center;

  &.level-error { background: rgba(var(--error-rgb), 0.12); color: $error; }
  &.level-warning { background: rgba(var(--warning-rgb), 0.12); color: $warning; }
  &.level-debug { background: rgba(var(--accent-primary-rgb), 0.06); color: $text-muted; }
  &.level-info { background: rgba(var(--accent-primary-rgb), 0.06); color: $text-muted; }
}

.log-logger {
  color: $text-muted;
  flex-shrink: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-message {
  color: $text-secondary;
  overflow: visible;
  white-space: normal;
  word-break: break-word;
  min-width: 0;
}

.access-method {
  font-weight: 600;
  color: $text-primary;
  flex-shrink: 0;
}

.access-path {
  color: $accent-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.access-status {
  font-weight: 600;
  flex-shrink: 0;
  font-size: 11px;

  &.status-2 { color: $success; }
  &.status-3 { color: $warning; }
  &.status-4 { color: $error; }
  &.status-5 { color: $error; }
}
</style>
