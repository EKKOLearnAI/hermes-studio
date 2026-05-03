<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'

const { t } = useI18n()
const usageStore = useUsageStore()

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function formatCost(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return '$' + n.toFixed(2)
}
</script>

<template>
  <div class="stat-cards">
    <div class="stat-card">
      <div class="stat-label">{{ t('usage.totalTokens') }}</div>
      <div class="stat-value">{{ formatTokens(usageStore.totalTokens) }}</div>
      <div class="stat-sub">
        {{ formatTokens(usageStore.totalInputTokens) }} {{ t('usage.inputTokens') }} /
        {{ formatTokens(usageStore.totalOutputTokens) }} {{ t('usage.outputTokens') }}
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">{{ t('usage.totalSessions') }}</div>
      <div class="stat-value">{{ usageStore.totalSessions }}</div>
      <div class="stat-sub">{{ t('usage.avgPerDay', { n: usageStore.avgSessionsPerDay.toFixed(1) }) }}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">{{ t('usage.estimatedCost') }}</div>
      <div class="stat-value">{{ formatCost(usageStore.estimatedCost) }}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">{{ t('usage.cacheHitRate') }}</div>
      <div class="stat-value">{{ usageStore.cacheHitRate !== null ? usageStore.cacheHitRate.toFixed(1) + '%' : '--' }}</div>
      <div class="stat-sub" v-if="usageStore.cacheHitRate !== null">
        {{ formatTokens(usageStore.totalCacheTokens) }} {{ t('usage.tokens') }}
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.stat-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.stat-card {
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.5);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  border: 1px solid rgba(var(--border-color-rgb, 224, 224, 224), 0.2);
  border-radius: $radius-md;
  padding: 16px;
  transition: all 0.25s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }

  .dark & {
    background: rgba(var(--bg-card-rgb, 51, 51, 51), 0.4);
  }
}

.stat-label {
  font-size: 12px;
  color: $text-muted;
  margin-bottom: 6px;
}

.stat-value {
  font-size: 22px;
  font-weight: 600;
  color: $text-primary;
  line-height: 1.2;
}

.stat-sub {
  font-size: 11px;
  color: $text-muted;
  margin-top: 4px;
}

@media (max-width: 768px) {
  .stat-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .stat-cards {
    grid-template-columns: 1fr;
  }
}
</style>
