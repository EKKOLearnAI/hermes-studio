<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HomeOverviewDto, HomeProviderDto } from '@/api/hermes/home'

const props = defineProps<{ overview: HomeOverviewDto | null; provider: HomeProviderDto | null }>()
const { t } = useI18n()
const currentProvider = computed(() => props.provider ?? props.overview?.provider ?? null)
const metrics = computed(() => {
  const summary = props.overview?.summary
  return [
    { key: 'devices', value: summary?.deviceCount ?? 0 },
    { key: 'unavailable', value: summary?.unavailableDeviceCount ?? 0, warning: !!summary?.unavailableDeviceCount },
    { key: 'inventory', value: summary?.inventoryItemCount ?? 0 },
    { key: 'lowStock', value: summary?.lowStockItemCount ?? 0, warning: !!summary?.lowStockItemCount },
    { key: 'workflows', value: summary?.activeWorkflowCount ?? 0, warning: !!summary?.activeWorkflowCount },
  ]
})
</script>

<template>
  <section class="home-overview" data-test="home-overview-panel">
    <div class="provider-summary">
      <div>
        <span class="eyebrow">{{ t('home.overview.title') }}</span>
        <h2>Home Assistant</h2>
        <p>{{ currentProvider?.profile || 'default' }}</p>
      </div>
      <span class="connection-pill" :class="currentProvider?.connectionStatus || 'unconfigured'" data-test="home-provider-status">
        {{ t(`home.status.${currentProvider?.connectionStatus || 'unconfigured'}`) }}
      </span>
    </div>

    <dl class="provider-details">
      <div>
        <dt>{{ t('home.overview.configured') }}</dt>
        <dd>{{ t(currentProvider?.configured ? 'home.status.yes' : 'home.status.no') }}</dd>
      </div>
      <div>
        <dt>{{ t('home.overview.executor') }}</dt>
        <dd>{{ t(currentProvider?.executorEnabled ? 'home.status.enabled' : 'home.status.disabled') }}</dd>
      </div>
      <div>
        <dt>{{ t('home.overview.authorizedTargets') }}</dt>
        <dd>{{ currentProvider?.authorizedTargetCount ?? 0 }}</dd>
      </div>
      <div v-if="currentProvider?.lastErrorCode" class="provider-error">
        <dt>Error</dt>
        <dd>{{ currentProvider.lastErrorCode }}</dd>
      </div>
    </dl>

    <div class="metric-grid">
      <article v-for="metric in metrics" :key="metric.key" :class="{ warning: metric.warning }">
        <strong>{{ metric.value }}</strong>
        <span>{{ t(`home.overview.${metric.key}`) }}</span>
      </article>
    </div>
  </section>
</template>

<style scoped lang="scss">
.home-overview {
  display: grid;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--card-color);
}
.provider-summary { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.eyebrow { color: var(--primary-color); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h2 { margin: 4px 0 0; font-size: 21px; }
p { margin: 4px 0 0; color: var(--text-color-2); }
.connection-pill {
  padding: 5px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--warning-color) 14%, transparent);
  color: var(--warning-color);
  font-size: 12px;
  font-weight: 700;
}
.connection-pill.connected { background: color-mix(in srgb, var(--success-color) 14%, transparent); color: var(--success-color); }
.connection-pill.degraded { background: color-mix(in srgb, var(--error-color) 12%, transparent); color: var(--error-color); }
.provider-details { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 0; }
.provider-details > div { padding: 10px 12px; border-radius: 8px; background: var(--action-color); }
dt { color: var(--text-color-3); font-size: 12px; }
dd { margin: 4px 0 0; font-weight: 650; overflow-wrap: anywhere; }
.provider-error dd { color: var(--error-color); }
.metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.metric-grid article { padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; }
.metric-grid strong { display: block; font-size: 22px; }
.metric-grid span { color: var(--text-color-2); font-size: 12px; }
.metric-grid .warning strong { color: var(--warning-color); }
@media (max-width: 760px) {
  .provider-details { grid-template-columns: repeat(2, 1fr); }
  .metric-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
