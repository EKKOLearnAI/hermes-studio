<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HealthConnectorDto, HealthDomain } from '@/api/hermes/health-loop'

const props = defineProps<{ connectors: HealthConnectorDto[] }>()
const { t } = useI18n()

const domains: HealthDomain[] = [
  'body_composition', 'measurements', 'posture', 'skin', 'diet', 'fitness', 'sleep', 'internal_health',
]

const rows = computed(() => domains.map(domain => {
  const sources = props.connectors.filter(connector => connector.domains.includes(domain))
  const timestamps = sources.flatMap(connector => connector.freshnessByDomain[domain] ? [connector.freshnessByDomain[domain]!] : [])
  timestamps.sort((a, b) => Date.parse(b) - Date.parse(a))
  return { domain, sourceCount: sources.length, timestamp: timestamps[0], state: sources.length ? (timestamps.length ? 'current' : 'missing') : 'unavailable' }
}))

const connectorErrors = computed(() => props.connectors.flatMap(connector => {
  if (!connector.errorCode) return []
  const safeCode = /^[a-z0-9_-]+$/i.test(connector.errorCode) ? connector.errorCode : 'connector_error'
  return [{ id: connector.id, code: safeCode }]
}))
</script>

<template>
  <section class="loop-panel" data-test="health-domain-status-grid" aria-labelledby="health-domain-title">
    <div class="heading">
      <h3 id="health-domain-title">{{ t('health.loop.domains.title') }}</h3>
      <span>{{ t('health.loop.domains.eightDomains') }}</span>
    </div>
    <div class="domain-grid">
      <article v-for="row in rows" :key="row.domain" data-test="health-domain-status" :data-state="row.state">
        <strong>{{ t(`health.loop.domains.${row.domain}`) }}</strong>
        <span>{{ t(`health.loop.freshness.${row.state}`) }}</span>
        <time v-if="row.timestamp" :datetime="row.timestamp">{{ row.timestamp }}</time>
        <small>{{ t('health.loop.domains.sources', { count: row.sourceCount }) }}</small>
      </article>
    </div>
    <ul v-if="connectorErrors.length" class="errors" :aria-label="t('health.loop.connectors.errors')">
      <li v-for="error in connectorErrors" :key="error.id" :data-test="`connector-error-${error.id}`">
        <strong>{{ error.id }}</strong><span>{{ error.code }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.loop-panel { min-width: 0; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-color); padding: 16px; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3 { margin: 0; font-size: 18px; }
.heading > span, article span, article small, article time { color: var(--text-color-3); font-size: 12px; }
.domain-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
article { display: grid; gap: 4px; min-width: 0; border: 1px solid var(--border-color); border-radius: 8px; padding: 10px; }
article[data-state="current"] { border-left: 3px solid var(--success-color); }
article[data-state="missing"] { border-left: 3px solid var(--warning-color); }
article time { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.errors { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
.errors li { border: 1px solid var(--error-color); border-radius: 8px; padding: 7px 9px; }
.errors span { margin-left: 8px; color: var(--error-color); }
@media (max-width: 900px) { .domain-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 520px) { .domain-grid { grid-template-columns: 1fr; } }
</style>
