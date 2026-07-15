<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { InternetWorkflowDetailDto, InternetWorkflowSummaryDto } from '@/api/hermes/internet-execution'

defineProps<{ workflow: InternetWorkflowSummaryDto | InternetWorkflowDetailDto | null; takeoverRequired: boolean; busy: boolean }>()
defineEmits<{ refresh: [] }>()
const { t } = useI18n()
function hasSteps(workflow: InternetWorkflowSummaryDto | InternetWorkflowDetailDto): workflow is InternetWorkflowDetailDto {
  return 'steps' in workflow
}
</script>

<template>
  <section class="panel" data-test="internet-workflow-panel">
    <header><h2>{{ t('internetExecution.workflow.title') }}</h2>
      <button :disabled="busy || !workflow" data-test="internet-workflow-refresh" @click="$emit('refresh')">{{ t('internetExecution.workflow.refresh') }}</button></header>
    <p v-if="!workflow" class="empty">{{ t('internetExecution.workflow.empty') }}</p>
    <template v-else>
      <div class="workflow-meta"><span>{{ t('internetExecution.workflow.state') }}</span><strong>{{ t(`internetExecution.workflowState.${workflow.state}`) }}</strong>
        <span>{{ t('internetExecution.workflow.attempt') }}</span><strong>{{ workflow.attempt + 1 }}</strong></div>
      <div v-if="takeoverRequired" class="takeover" data-test="internet-takeover-state">
        <strong>{{ t('internetExecution.workflow.takeoverTitle') }}</strong>
        <p>{{ t('internetExecution.workflow.takeoverSummary') }}</p>
        <small>{{ t('internetExecution.workflow.takeoverPrivacy') }}</small>
      </div>
      <ol v-if="hasSteps(workflow) && workflow.steps.length">
        <li v-for="step in workflow.steps" :key="step.kind"><span>{{ step.kind }}</span><strong>{{ step.state }}</strong></li>
      </ol>
      <p v-if="workflow.lastErrorCode" class="error">{{ workflow.lastErrorCode }}</p>
    </template>
  </section>
</template>

<style scoped>
.panel { padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); } header { display: flex; justify-content: space-between; gap: 10px; } h2 { margin: 0; font-size: 18px; } button { padding: 6px 9px; border: 1px solid var(--border-color); border-radius: 6px; background: transparent; color: var(--text-color); cursor: pointer; } button:disabled { opacity: .45; }
.workflow-meta { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; margin-top: 14px; }.workflow-meta span { color: var(--text-color-3); }.takeover { margin-top: 14px; padding: 12px; border: 1px solid color-mix(in srgb, var(--warning-color) 35%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--warning-color) 8%, transparent); }.takeover p { margin: 5px 0; }.takeover small { color: var(--text-color-2); }
ol { display: grid; gap: 5px; padding: 0; margin: 14px 0 0; list-style: none; }li { display: flex; justify-content: space-between; padding: 7px 9px; border-radius: 6px; background: var(--action-color); font-size: 12px; }li strong { color: var(--text-color-2); }.empty { color: var(--text-color-3); }.error { color: var(--error-color); }
</style>
