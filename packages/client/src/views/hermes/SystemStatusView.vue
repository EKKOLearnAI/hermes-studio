<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NSpin, NTag, useMessage } from 'naive-ui'
import {
  fetchSystemStatus,
  runSystemStatusAction,
  type SystemComponentStatus,
  type SystemStatusAction,
  type SystemStatusResponse,
} from '@/api/hermes/system-status'

const message = useMessage()
const status = ref<SystemStatusResponse | null>(null)
const loading = ref(false)
const actionLoading = ref<Record<string, boolean>>({})
let timer: number | null = null

interface QuickAction {
  action: SystemStatusAction
  label: string
  kind?: 'primary' | 'default'
}

const statusCounts = computed(() => {
  const counts = { ok: 0, warn: 0, error: 0, unknown: 0 }
  for (const item of status.value?.components || []) {
    counts[item.status] += 1
  }
  return counts
})

const summaryText = computed(() => {
  if (!status.value) return '尚未檢查'
  if (status.value.status === 'ok') return '所有核心服務都在線'
  if (status.value.status === 'warn') return '有服務需要留意'
  return '有核心服務異常'
})

function tagType(value: SystemComponentStatus) {
  if (value === 'ok') return 'success'
  if (value === 'warn') return 'warning'
  if (value === 'error') return 'error'
  return 'default'
}

function labelFor(value: SystemComponentStatus) {
  if (value === 'ok') return '正常'
  if (value === 'warn') return '注意'
  if (value === 'error') return '異常'
  return '未知'
}

function formatTime(value?: string) {
  if (!value) return 'n/a'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-TW', { hour12: false })
}

function compactPath(value?: string) {
  if (!value) return ''
  return value.replace('/Users/kk/', '~/')
}

function metadataLabel(key: string) {
  const labels: Record<string, string> = {
    mode: '模式',
    provider: 'Provider',
    model: '模型',
    endpoint_kind: '端點',
    timeout_ms: 'Timeout',
    is_ollama: 'Ollama',
    api_key_configured: 'Key',
    profile: 'Profile',
    running: 'Running',
    port: 'Port',
  }
  return labels[key] || key
}

function metadataValue(key: string, value: unknown) {
  if (key === 'timeout_ms' && typeof value === 'number') return `${Math.round(value / 1000)}s`
  if (key === 'api_key_configured') return value ? '已設定' : '未設定'
  if (key === 'is_ollama') return value ? '是' : '否'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (value === null || typeof value === 'undefined') return 'n/a'
  return String(value)
}

function metadataRows(item: SystemStatusResponse['components'][number]) {
  return Object.entries(item.metadata || {})
    .filter(([, value]) => value !== null && typeof value !== 'undefined' && value !== '')
    .map(([key, value]) => ({ key, label: metadataLabel(key), value: metadataValue(key, value) }))
}

function actionsFor(key: string): QuickAction[] {
  if (key === 'hermes-gateway') {
    return [{ action: 'restart-gateway', label: '重啟 Gateway', kind: 'primary' }]
  }
  if (key === 'mirofish-backend' || key === 'mirofish-frontend') {
    return [
      { action: 'open-mirofish', label: '開啟 MiroFish' },
      { action: 'restart-mirofish', label: '重啟 MiroFish', kind: 'primary' },
    ]
  }
  if (key === 'mirofish-launchd') {
    return [{ action: 'restart-mirofish', label: '重啟服務', kind: 'primary' }]
  }
  if (key === 'obsidian-app') {
    return [{ action: 'open-obsidian', label: '開啟 Obsidian' }]
  }
  if (key === 'obsidian-vault') {
    return [
      { action: 'open-obsidian', label: '開啟 Obsidian' },
      { action: 'open-knowledge-vault', label: '開啟資料夾' },
    ]
  }
  if (key === 'latest-yahoo-mirofish') {
    return [{ action: 'open-latest-report', label: '開啟報告' }]
  }
  return []
}

async function loadStatus() {
  loading.value = true
  try {
    status.value = await fetchSystemStatus()
  } catch (err: any) {
    message.error(err?.message || '狀態檢查失敗')
  } finally {
    loading.value = false
  }
}

async function runAction(action: SystemStatusAction) {
  actionLoading.value[action] = true
  try {
    const result = await runSystemStatusAction(action)
    message.success(result.message || '操作完成')
    window.setTimeout(loadStatus, 1_200)
  } catch (err: any) {
    message.error(err?.message || '操作失敗')
  } finally {
    actionLoading.value[action] = false
  }
}

onMounted(() => {
  loadStatus()
  timer = window.setInterval(loadStatus, 30_000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="system-status-view">
    <header class="page-header">
      <div>
        <p class="system-eyebrow">Aurora System</p>
        <h2 class="header-title">系統狀態</h2>
        <p class="header-subtitle">Core services, local agents, and memory infrastructure</p>
      </div>
      <NButton size="small" :loading="loading" @click="loadStatus">重新檢查</NButton>
    </header>

    <div class="status-content">
      <NSpin :show="loading && !status" size="large">
        <section class="summary-band" :class="status?.status || 'unknown'">
          <div>
            <div class="summary-kicker">目前狀態</div>
            <div class="summary-title">{{ summaryText }}</div>
            <div class="summary-meta">
              Profile: <code>{{ status?.profile || 'n/a' }}</code>
              <span>檢查時間：{{ formatTime(status?.checked_at) }}</span>
            </div>
          </div>
          <div class="summary-counts">
            <div class="count-pill ok"><strong>{{ statusCounts.ok }}</strong><span>正常</span></div>
            <div class="count-pill warn"><strong>{{ statusCounts.warn }}</strong><span>注意</span></div>
            <div class="count-pill error"><strong>{{ statusCounts.error }}</strong><span>異常</span></div>
            <div class="count-pill unknown"><strong>{{ statusCounts.unknown }}</strong><span>未知</span></div>
          </div>
        </section>

        <section class="service-grid">
          <article
            v-for="item in status?.components || []"
            :key="item.key"
            class="service-card"
            :class="item.status"
          >
            <div class="service-top">
              <div class="service-name">{{ item.label }}</div>
              <NTag :type="tagType(item.status)" size="small" round>{{ labelFor(item.status) }}</NTag>
            </div>

            <div class="service-summary">{{ item.summary }}</div>

            <div v-if="actionsFor(item.key).length" class="service-actions">
              <NButton
                v-for="entry in actionsFor(item.key)"
                :key="entry.action"
                size="tiny"
                secondary
                :type="entry.kind === 'primary' ? 'primary' : 'default'"
                :loading="actionLoading[entry.action]"
                @click="runAction(entry.action)"
              >
                {{ entry.label }}
              </NButton>
            </div>

            <div class="service-meta">
              <div v-if="item.url" class="meta-row">
                <span>URL</span>
                <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.url }}</a>
              </div>
              <div v-if="item.path" class="meta-row">
                <span>Path</span>
                <code>{{ compactPath(item.path) }}</code>
              </div>
              <div v-if="item.pid" class="meta-row">
                <span>PID</span>
                <code>{{ item.pid }}</code>
              </div>
              <div
                v-for="entry in metadataRows(item)"
                :key="entry.key"
                class="meta-row"
              >
                <span>{{ entry.label }}</span>
                <code>{{ entry.value }}</code>
              </div>
              <div v-if="item.detail" class="meta-row detail">
                <span>Detail</span>
                <pre>{{ item.detail }}</pre>
              </div>
            </div>
          </article>
        </section>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.system-status-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
  color: $text-primary;
  background:
    radial-gradient(740px 260px at 12% 0%, rgba(147, 197, 253, 0.22), transparent 62%),
    radial-gradient(620px 320px at 92% 8%, rgba(196, 181, 253, 0.22), transparent 64%),
    linear-gradient(135deg, rgba(248, 251, 255, 0.9), rgba(245, 241, 255, 0.78));
}

.page-header {
  gap: 12px;
  flex-wrap: wrap;
  margin: 14px 14px 0;
  padding: 18px 20px;
  border: 1px solid rgba(255, 255, 255, 0.54);
  border-radius: 22px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.54), rgba(255, 255, 255, 0.22)),
    rgba(255, 255, 255, 0.32);
  box-shadow: 0 18px 52px rgba(66, 84, 117, 0.13), inset 0 1px 0 rgba(255, 255, 255, 0.66);
  backdrop-filter: blur(24px);
}

.system-eyebrow {
  margin: 0 0 6px;
  color: rgba(97, 80, 220, 0.68);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.16em;
  line-height: 1;
  text-transform: uppercase;
}

.header-title {
  margin: 0;
  color: rgba(21, 32, 51, 0.88);
  font-size: 22px;
  font-weight: 900;
  line-height: 1.1;
}

.page-header :deep(.n-button) {
  border: 1px solid rgba(121, 99, 255, 0.16);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.44);
  font-weight: 850;
}

.header-subtitle {
  margin: 4px 0 0;
  color: $text-muted;
  font-size: 13px;
}

.status-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}

.summary-band {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 20px;
  margin-bottom: 16px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 24px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.18)),
    rgba(255, 255, 255, 0.3);
  box-shadow: 0 18px 52px rgba(66, 84, 117, 0.13), inset 0 1px 0 rgba(255, 255, 255, 0.62);
  backdrop-filter: blur(24px);

  &.ok { box-shadow: 0 18px 52px rgba(66, 84, 117, 0.13), inset 4px 0 0 rgba(16, 185, 129, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.62); }
  &.warn,
  &.unknown { box-shadow: 0 18px 52px rgba(66, 84, 117, 0.13), inset 4px 0 0 rgba(245, 158, 11, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.62); }
  &.error { box-shadow: 0 18px 52px rgba(66, 84, 117, 0.13), inset 4px 0 0 rgba(244, 63, 94, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.62); }
}

.summary-kicker {
  color: $text-muted;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0;
}

.summary-title {
  margin-top: 4px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 22px;
  font-weight: 900;
}

.summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 8px;
  color: $text-muted;
  font-size: 12px;
}

.summary-counts {
  display: grid;
  grid-template-columns: repeat(4, minmax(56px, 1fr));
  gap: 8px;
  flex: 0 0 auto;
}

.count-pill {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 56px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.26);

  strong {
    color: $text-primary;
    font-size: 18px;
    line-height: 1.1;
  }

  span {
    margin-top: 2px;
    color: $text-muted;
    font-size: 11px;
  }
}

.service-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.service-card {
  min-width: 0;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.44);
  border-radius: 20px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.14)),
    rgba(255, 255, 255, 0.24);
  box-shadow: 0 16px 44px rgba(66, 84, 117, 0.11), inset 0 1px 0 rgba(255, 255, 255, 0.52);
  backdrop-filter: blur(20px);

  &.ok { box-shadow: 0 16px 44px rgba(66, 84, 117, 0.11), inset 3px 0 0 rgba(16, 185, 129, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.52); }
  &.warn,
  &.unknown { box-shadow: 0 16px 44px rgba(66, 84, 117, 0.11), inset 3px 0 0 rgba(245, 158, 11, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.52); }
  &.error { box-shadow: 0 16px 44px rgba(66, 84, 117, 0.11), inset 3px 0 0 rgba(244, 63, 94, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.52); }
}

.service-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.service-name {
  min-width: 0;
  color: rgba(21, 32, 51, 0.88);
  font-size: 14px;
  font-weight: 900;
}

.service-summary {
  margin-top: 10px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.45;
}

.service-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.service-actions :deep(.n-button) {
  border-radius: 999px;
  font-weight: 850;
}

.service-meta {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 14px;
}

.meta-row {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  color: $text-muted;
  font-size: 12px;

  span {
    color: $text-muted;
  }

  a,
  code,
  pre {
    min-width: 0;
    color: $text-secondary;
    overflow-wrap: anywhere;
  }

  pre {
    margin: 0;
    white-space: pre-wrap;
    font-family: $font-code;
    font-size: 11px;
    line-height: 1.45;
  }
}

@media (max-width: 760px) {
  .status-content {
    padding: 16px;
  }

  .summary-band {
    align-items: stretch;
    flex-direction: column;
  }

  .summary-counts {
    grid-template-columns: repeat(2, 1fr);
  }

  .service-grid {
    grid-template-columns: 1fr;
  }
}

:global(.dark) .system-status-view {
  background:
    radial-gradient(740px 260px at 12% 0%, rgba(59, 130, 246, 0.16), transparent 62%),
    radial-gradient(620px 320px at 92% 8%, rgba(139, 92, 246, 0.16), transparent 64%),
    linear-gradient(135deg, rgba(15, 23, 42, 0.92), rgba(30, 27, 75, 0.8));
}

:global(.dark) .page-header,
:global(.dark) .summary-band,
:global(.dark) .service-card,
:global(.dark) .count-pill {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(15, 23, 42, 0.42);
}

:global(.dark) .header-title,
:global(.dark) .summary-title,
:global(.dark) .service-name {
  color: rgba(248, 250, 252, 0.92);
}
</style>
