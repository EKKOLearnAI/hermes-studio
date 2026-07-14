<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HomeWorkflowDetailDto, HomeWorkflowSummaryDto } from '@/api/hermes/home'

const props = defineProps<{ workflow: HomeWorkflowSummaryDto | HomeWorkflowDetailDto | null; canWrite: boolean; busy?: boolean }>()
const emit = defineEmits<{
  review: [payload: { action: 'approve' } | { action: 'reject'; reason: string }]
  refresh: []
}>()
const { t } = useI18n()
const rejecting = ref(false)
const rejectionReason = ref('')
const steps = computed(() => props.workflow && 'steps' in props.workflow ? props.workflow.steps : [])

function reject() {
  const reason = rejectionReason.value.trim()
  if (!reason) return
  emit('review', { action: 'reject', reason })
  rejecting.value = false
  rejectionReason.value = ''
}
</script>

<template>
  <section class="workflow-panel" data-test="home-workflow-panel">
    <header>
      <h2>{{ t('home.workflow.title') }}</h2>
      <button v-if="workflow" :disabled="busy" data-test="home-workflow-refresh" @click="emit('refresh')">{{ t('home.workflow.refresh') }}</button>
    </header>
    <p v-if="!workflow" class="empty">{{ t('home.workflow.empty') }}</p>
    <template v-else>
      <div class="workflow-heading">
        <div>
          <span>{{ workflow.id }}</span>
          <strong>{{ t(`health.loop.workflow.${workflow.state}`) }}</strong>
        </div>
        <span class="workflow-state" :class="workflow.state">{{ workflow.state }}</span>
      </div>
      <dl class="workflow-meta">
        <div><dt>{{ t('home.workflow.attempt') }}</dt><dd>{{ workflow.attempt }}</dd></div>
        <div><dt>Version</dt><dd>{{ workflow.version }}</dd></div>
        <div v-if="workflow.lastErrorCode" class="workflow-error"><dt>Error</dt><dd>{{ workflow.lastErrorCode }}</dd></div>
      </dl>
      <div v-if="steps.length" class="workflow-steps">
        <span class="section-label">{{ t('home.workflow.steps') }}</span>
        <ol>
          <li v-for="(step, index) in steps" :key="`${step.kind}:${index}`">
            <span>{{ index + 1 }}</span><div><strong>{{ step.kind }}</strong><small>{{ step.state }}</small></div>
          </li>
        </ol>
      </div>
      <div v-if="canWrite && (workflow.availableActions.approve || workflow.availableActions.reject)" class="review-actions">
        <button v-if="workflow.availableActions.reject" :disabled="busy" data-test="home-workflow-reject" @click="rejecting = true">{{ t('home.workflow.reject') }}</button>
        <button v-if="workflow.availableActions.approve" class="primary" :disabled="busy" data-test="home-workflow-approve"
          @click="emit('review', { action: 'approve' })">{{ t('home.workflow.approve') }}</button>
      </div>
      <form v-if="rejecting" class="reject-form" @submit.prevent="reject">
        <label>{{ t('home.workflow.rejectionReason') }}
          <textarea v-model="rejectionReason" rows="3" :placeholder="t('home.workflow.rejectionPlaceholder')" data-test="home-workflow-rejection-reason" />
        </label>
        <div>
          <button type="button" @click="rejecting = false">{{ t('home.devices.cancel') }}</button>
          <button type="submit" class="danger" :disabled="!rejectionReason.trim()" data-test="home-workflow-reject-confirm">{{ t('home.workflow.reject') }}</button>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped lang="scss">
.workflow-panel { padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); }
header, .workflow-heading, .review-actions, .reject-form > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header { margin-bottom: 14px; }
h2, p { margin: 0; }
.empty { color: var(--text-color-3); }
button { padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: transparent; color: var(--text-color); cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }
.workflow-heading > div { display: grid; gap: 4px; min-width: 0; }
.workflow-heading span { color: var(--text-color-3); font-family: monospace; font-size: 11px; overflow-wrap: anywhere; }
.workflow-state { padding: 4px 8px; border-radius: 999px; background: var(--action-color); color: var(--primary-color); font-size: 11px; }
.workflow-state.failed, .workflow-state.dead_letter, .workflow-state.denied { color: var(--error-color); }
.workflow-state.succeeded { color: var(--success-color); }
.workflow-meta { display: flex; gap: 8px; margin: 14px 0; }
.workflow-meta div { min-width: 80px; padding: 8px 10px; border-radius: 7px; background: var(--action-color); }
dt, .section-label { color: var(--text-color-3); font-size: 11px; }
dd { margin: 3px 0 0; font-weight: 700; overflow-wrap: anywhere; }
.workflow-error { flex: 1; color: var(--error-color); }
.workflow-steps ol { display: flex; gap: 6px; margin: 8px 0 14px; padding: 0; list-style: none; overflow-x: auto; }
.workflow-steps li { display: flex; align-items: center; gap: 7px; min-width: 105px; padding: 8px; border: 1px solid var(--border-color); border-radius: 7px; }
.workflow-steps li > span { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--action-color); font-size: 11px; }
.workflow-steps li div { display: grid; }
.workflow-steps small { color: var(--text-color-3); }
.review-actions { justify-content: flex-end; }
.primary { border-color: var(--primary-color); background: var(--primary-color); color: white; }
.reject-form { margin-top: 12px; padding: 12px; border: 1px solid color-mix(in srgb, var(--error-color) 40%, var(--border-color)); border-radius: 8px; }
.reject-form label { display: grid; gap: 6px; }
.reject-form textarea { resize: vertical; padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--input-color); color: var(--text-color); }
.reject-form > div { justify-content: flex-end; margin-top: 9px; }
.danger { border-color: var(--error-color); color: var(--error-color); }
</style>
