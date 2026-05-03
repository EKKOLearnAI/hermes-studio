<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'

const { t } = useI18n()
const usageStore = useUsageStore()
const maxModelTokens = computed(() => Math.max(usageStore.modelUsage[0]?.totalTokens || 0, 1))

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}
</script>

<template>
  <div class="model-breakdown">
    <h3 class="section-title">{{ t('usage.modelBreakdown') }}</h3>
    <div class="model-list">
      <div v-for="m in usageStore.modelUsage" :key="m.model" class="model-row">
        <span class="model-name">{{ m.model }}</span>
        <div class="model-bar-wrap">
          <div
            class="model-bar"
            :style="{ width: (m.totalTokens / maxModelTokens * 100) + '%' }"
          />
        </div>
        <span class="model-tokens">{{ formatTokens(m.totalTokens) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.model-breakdown {
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.5);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  border: 1px solid rgba(var(--border-color-rgb, 224, 224, 224), 0.2);
  border-radius: $radius-md;
  padding: 16px;
  margin-bottom: 20px;

  .dark & {
    background: rgba(var(--bg-card-rgb, 51, 51, 51), 0.4);
  }
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: $text-secondary;
  margin: 0 0 12px;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.model-name {
  font-size: 12px;
  font-family: $font-code;
  color: $text-secondary;
  width: 140px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-bar-wrap {
  flex: 1;
  height: 16px;
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.3);
  border-radius: 3px;
  overflow: hidden;
}

.model-bar {
  height: 100%;
  background: $text-primary;
  border-radius: 3px;
  min-width: 2px;
  transition: width 0.3s ease;

  .dark & {
    background: #66bb6a;
  }
}

.model-tokens {
  font-size: 12px;
  color: $text-muted;
  width: 60px;
  text-align: right;
  flex-shrink: 0;
}
</style>
