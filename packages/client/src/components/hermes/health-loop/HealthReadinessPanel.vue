<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HealthConnectorDto } from '@/api/hermes/health-loop'

export type HealthCommandAction =
  | { kind: 'sync'; connectorId: string }
  | { kind: 'capture' }
  | { kind: 'review' }

const props = defineProps<{
  connectors: HealthConnectorDto[]
  activeInterventionCount: number
}>()
const emit = defineEmits<{ action: [action: HealthCommandAction] }>()
const { t } = useI18n()

const connectorNeedingAttention = computed(() => props.connectors.find(connector =>
  !connector.configured
  || connector.health === 'degraded'
  || connector.health === 'unhealthy'
  || connector.health === 'unavailable'
  || connector.authorizationState === 'required'
  || connector.authorizationState === 'expired',
))

const primaryAction = computed<HealthCommandAction>(() => {
  if (connectorNeedingAttention.value) return { kind: 'sync', connectorId: connectorNeedingAttention.value.id }
  if (props.activeInterventionCount > 0) return { kind: 'review' }
  return { kind: 'capture' }
})

const alternatives = computed<HealthCommandAction[]>(() => {
  const actions: HealthCommandAction[] = [{ kind: 'capture' }, { kind: 'review' }]
  const firstConnector = props.connectors[0]
  if (firstConnector) actions.push({ kind: 'sync', connectorId: firstConnector.id })
  return actions.filter(action => actionKey(action) !== actionKey(primaryAction.value))
})

const readiness = computed(() => {
  if (!props.connectors.length) return 'setup'
  if (connectorNeedingAttention.value) return 'attention'
  return 'ready'
})

function actionKey(action: HealthCommandAction): string {
  return action.kind === 'sync' ? `sync:${action.connectorId}` : action.kind
}

function actionLabel(action: HealthCommandAction): string {
  if (action.kind === 'sync') return t('health.loop.actions.syncConnector', { connector: action.connectorId })
  return t(`health.loop.actions.${action.kind}`)
}
</script>

<template>
  <section class="loop-panel readiness" data-test="health-readiness-panel" aria-labelledby="health-readiness-title">
    <div class="heading">
      <div>
        <span class="eyebrow">{{ t('health.loop.readiness.eyebrow') }}</span>
        <h3 id="health-readiness-title">{{ t('health.loop.readiness.title') }}</h3>
      </div>
      <span class="status" :data-status="readiness">{{ t(`health.loop.readiness.${readiness}`) }}</span>
    </div>
    <p>{{ t('health.loop.readiness.summary') }}</p>
    <button
      class="primary"
      type="button"
      data-test="primary-health-action"
      :aria-label="actionLabel(primaryAction)"
      @click="emit('action', primaryAction)"
    >
      <small>{{ t('health.loop.readiness.primary') }}</small>
      <strong>{{ actionLabel(primaryAction) }}</strong>
    </button>
    <div class="alternatives" :aria-label="t('health.loop.readiness.alternatives')">
      <button
        v-for="action in alternatives"
        :key="actionKey(action)"
        type="button"
        data-test="alternative-health-action"
        @click="emit('action', action)"
      >
        {{ actionLabel(action) }}
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.loop-panel { min-width: 0; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-color); padding: 16px; }
.heading { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
h3 { margin: 2px 0 0; font-size: 18px; }
p { color: var(--text-color-2); }
.eyebrow { color: var(--text-color-3); font-size: 11px; text-transform: uppercase; }
.status { border: 1px solid var(--border-color); border-radius: 999px; padding: 4px 8px; font-size: 12px; }
.status[data-status="ready"] { border-color: var(--success-color); color: var(--success-color); }
.status[data-status="attention"] { border-color: var(--warning-color); color: var(--warning-color); }
button { font: inherit; cursor: pointer; }
.primary { display: grid; gap: 4px; width: 100%; border: 0; border-radius: 10px; background: var(--primary-color); color: white; padding: 12px 14px; text-align: left; }
.primary small { opacity: .8; }
.alternatives { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.alternatives button { border: 1px solid var(--border-color); border-radius: 8px; background: transparent; color: var(--text-color-2); padding: 7px 10px; }
</style>
