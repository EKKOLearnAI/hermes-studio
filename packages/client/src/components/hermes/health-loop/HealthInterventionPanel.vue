<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HealthActionResponseDto, HealthFeedbackOutcome, HealthInterventionDto } from '@/api/hermes/health-loop'

const props = defineProps<{
  interventions: HealthInterventionDto[]
  workflow?: HealthActionResponseDto['workflow'] | null
}>()
const emit = defineEmits<{
  feedback: [payload: { interventionId: string; outcome: HealthFeedbackOutcome }]
  'workflow-action': [action: keyof HealthActionResponseDto['workflow']['availableActions']]
}>()
const { t } = useI18n()

const active = computed(() => props.interventions.filter(item => item.status === 'active'))
const workflowActions = ['approve', 'reject', 'cancel', 'retry', 'compensate'] as const
const feedbackActions: HealthFeedbackOutcome[] = ['completed', 'partial', 'deferred', 'adverse_feedback']
</script>

<template>
  <section class="loop-panel" data-test="health-intervention-panel" aria-labelledby="health-intervention-title">
    <div class="heading">
      <h3 id="health-intervention-title">{{ t('health.loop.interventions.title') }}</h3>
      <span>{{ t('health.loop.interventions.activeCount', { count: active.length }) }}</span>
    </div>

    <div v-if="workflow" class="workflow" data-test="active-health-workflow">
      <div>
        <strong>{{ workflow.id }}</strong>
        <span>{{ t(`health.loop.workflow.${workflow.state}`) }}</span>
      </div>
      <div v-if="workflow.state === 'waiting_user'" class="confirmation" role="status">
        {{ t('health.loop.workflow.confirmationRequired') }}
      </div>
      <div class="actions">
        <button
          v-for="action in workflowActions.filter(action => workflow?.availableActions?.[action] === true)"
          :key="action"
          type="button"
          :data-test="`workflow-action-${action}`"
          :aria-label="t(`health.loop.workflow.actions.${action}`)"
          @click="emit('workflow-action', action)"
        >
          {{ t(`health.loop.workflow.actions.${action}`) }}
        </button>
      </div>
    </div>

    <article v-for="item in active" :key="item.interventionId" class="intervention">
      <div>
        <strong>{{ t(`health.loop.interventions.categories.${item.category}`) }}</strong>
        <span>{{ item.workflowId }}</span>
      </div>
      <p>{{ t('health.loop.interventions.riskAuthority', { risk: item.risk, authority: item.authority }) }}</p>
      <div class="actions" :aria-label="t('health.loop.feedback.title')">
        <button
          v-for="outcome in feedbackActions"
          :key="outcome"
          type="button"
          :data-test="`feedback-${outcome}`"
          @click="emit('feedback', { interventionId: item.interventionId, outcome })"
        >
          {{ t(`health.loop.feedback.${outcome}`) }}
        </button>
      </div>
    </article>
    <p v-if="!active.length" class="empty">{{ t('health.loop.interventions.empty') }}</p>
  </section>
</template>

<style scoped lang="scss">
.loop-panel { min-width: 0; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-color); padding: 16px; }
.heading, .workflow > div:first-child, .intervention > div:first-child { display: flex; justify-content: space-between; gap: 12px; }
h3 { margin: 0; font-size: 18px; }
.heading span, .workflow span, .intervention span, .intervention p, .empty { color: var(--text-color-3); font-size: 12px; }
.workflow, .intervention { display: grid; gap: 10px; border: 1px solid var(--border-color); border-radius: 8px; margin-top: 12px; padding: 11px; }
.confirmation { border-radius: 8px; background: color-mix(in srgb, var(--warning-color) 12%, transparent); color: var(--warning-color); padding: 8px; font-size: 12px; }
.intervention p { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 7px; }
.actions button { border: 1px solid var(--border-color); border-radius: 7px; background: transparent; color: var(--text-color-2); cursor: pointer; font: inherit; padding: 6px 9px; }
</style>
