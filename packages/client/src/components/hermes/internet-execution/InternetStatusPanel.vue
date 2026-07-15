<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InternetOverviewDto } from '@/api/hermes/internet-execution'

const props = defineProps<{ overview: InternetOverviewDto | null }>()
const { t } = useI18n()
const mcp = computed(() => props.overview?.executors.find(item => item.type === 'mcp') ?? null)
const browser = computed(() => props.overview?.executors.find(item => item.type === 'browser') ?? null)
</script>

<template>
  <section class="panel status-panel" data-test="internet-status-panel">
    <header><div><span class="eyebrow">{{ t('internetExecution.status.kicker') }}</span><h2>{{ t('internetExecution.status.title') }}</h2></div>
      <span class="provider-state" :class="overview?.provider.executorEnabled ? 'ready' : 'blocked'">
        {{ overview?.provider.executorEnabled ? t('internetExecution.status.ready') : t('internetExecution.status.unavailable') }}
      </span>
    </header>
    <div v-if="overview" class="status-grid">
      <article><span>{{ t('internetExecution.status.provider') }}</span><strong>Bilibili · {{ overview.provider.profile }}</strong>
        <small>{{ t(`internetExecution.status.${overview.provider.discoveryStatus}`) }}</small></article>
      <article><span>{{ t('internetExecution.status.preferred') }}</span><strong>MCP</strong>
        <small>{{ t(`internetExecution.status.${mcp?.health ?? 'unknown'}`) }}</small></article>
      <article><span>{{ t('internetExecution.status.fallback') }}</span><strong>{{ t('internetExecution.status.browser') }}</strong>
        <small>{{ t(`internetExecution.status.${browser?.health ?? 'unknown'}`) }}</small></article>
      <article><span>{{ t('internetExecution.status.verified') }}</span><strong>{{ overview.summary.verifiedReceiptCount }}</strong>
        <small>{{ t('internetExecution.status.receipts', { count: overview.summary.receiptCount }) }}</small></article>
    </div>
    <p v-else class="empty">{{ t('internetExecution.status.loading') }}</p>
    <div class="path-explanation">
      <p><strong>{{ t('internetExecution.status.mcpFirst') }}</strong> {{ t('internetExecution.status.mcpFirstSummary') }}</p>
      <p><strong>{{ t('internetExecution.status.browserRecovery') }}</strong> {{ t('internetExecution.status.browserRecoverySummary') }}</p>
    </div>
    <p v-if="overview?.provider.lastErrorCode" class="warning" role="status">
      {{ t('internetExecution.status.runtimeIssue') }} · {{ overview.provider.lastErrorCode }}
    </p>
  </section>
</template>

<style scoped>
.panel { padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); }
header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
h2 { margin: 3px 0 0; font-size: 18px; }.eyebrow { color: var(--primary-color); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.provider-state { padding: 4px 9px; border-radius: 999px; font-size: 12px; }.ready { color: var(--success-color); background: color-mix(in srgb, var(--success-color) 10%, transparent); }.blocked { color: var(--error-color); background: color-mix(in srgb, var(--error-color) 10%, transparent); }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
article { display: grid; gap: 3px; min-width: 0; padding: 12px; border-radius: 9px; background: var(--action-color); } article span, article small { color: var(--text-color-3); } article strong { overflow: hidden; text-overflow: ellipsis; }
.path-explanation { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }.path-explanation p { margin: 0; color: var(--text-color-2); font-size: 13px; }.path-explanation strong { color: var(--text-color); }
.warning { margin: 12px 0 0; color: var(--warning-color); }.empty { color: var(--text-color-3); }
@media (max-width: 800px) { .status-grid { grid-template-columns: 1fr 1fr; }.path-explanation { grid-template-columns: 1fr; } }
</style>
