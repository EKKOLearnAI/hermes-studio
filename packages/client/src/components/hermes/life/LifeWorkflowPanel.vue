<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LifeCalendarHoldDto, LifeTakeoverDto, LifeWorkflowDto } from '@/api/hermes/life-orchestration'
const props = defineProps<{ workflows: LifeWorkflowDto[]; takeovers: LifeTakeoverDto[]; holds: LifeCalendarHoldDto[]
  selectedId: string | null; canReview: boolean; canWrite: boolean; busy: boolean }>()
const emit = defineEmits<{ select: [id: string]; review: [value: { id: string; action: 'approve' | 'reject'; reason: string }]
  cancelHold: [id: string] }>()
const { t } = useI18n(); const rejectReason = ref('USER_REJECTED')
const selected = computed(() => props.workflows.find(item => item.id === props.selectedId) ?? null)
</script>
<template><section class="panel" data-test="life-workflow-panel"><h2>{{ t('life.workflow.title') }}</h2><p>{{ t('life.workflow.summary') }}</p>
  <div v-if="takeovers.length" class="takeovers"><h3>{{ t('life.workflow.takeovers') }}</h3><article v-for="item in takeovers" :key="item.workflowId">
    <b>{{ item.capabilityId }}</b><span>{{ item.reasonCode }}</span><button @click="$emit('select', item.workflowId)">{{ t('life.workflow.review') }}</button></article>
    <p>{{ t('life.workflow.takeoverPrivacy') }}</p></div>
  <div class="workflows"><button v-for="item in workflows" :key="item.id" :class="{ active: item.id === selectedId }" @click="$emit('select', item.id)">
    <span><b>{{ item.capabilityId }}</b><small>{{ item.id }}</small></span><i>{{ t(`life.workflowState.${item.state}`) }}</i></button>
    <p v-if="!workflows.length">{{ t('life.workflow.empty') }}</p></div>
  <div v-if="selected?.state === 'waiting_user'" class="review"><input v-model="rejectReason" :placeholder="t('life.workflow.reason')" />
    <button :disabled="busy || !canReview || !selected.availableActions.approve" data-test="life-approve-workflow"
      @click="$emit('review', { id: selected.id, action: 'approve', reason: '' })">{{ t('life.workflow.approve') }}</button>
    <button :disabled="busy || !canReview || !selected.availableActions.reject" data-test="life-reject-workflow"
      @click="$emit('review', { id: selected.id, action: 'reject', reason: rejectReason })">{{ t('life.workflow.reject') }}</button></div>
  <details><summary>{{ t('life.workflow.holds') }} ({{ holds.length }})</summary><div class="holds"><article v-for="item in holds" :key="item.id"><span>{{ item.optionId }} · {{ item.state }}</span>
    <button :disabled="busy || !canWrite || item.state !== 'confirmed'" @click="$emit('cancelHold', item.id)">{{ t('life.workflow.cancelHold') }}</button></article></div></details>
</section></template>
<style scoped>.panel{padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color)}h2,h3{margin:0 0 5px}.panel>p,small,.takeovers p{color:var(--text-color-3)}button,input{padding:7px 9px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit}.workflows>button{width:100%;display:flex;justify-content:space-between;text-align:left;border-width:1px 0 0;border-radius:0}.workflows>button.active{background:var(--action-color)}.workflows span{display:grid}.workflows i{font-style:normal}.takeovers{padding:12px;border-radius:8px;background:color-mix(in srgb,var(--warning-color) 10%,transparent)}.takeovers article,.holds article,.review{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:6px 0}.review{justify-content:flex-start}summary{padding:10px 0;cursor:pointer}@media(max-width:600px){.takeovers article,.holds article,.review{align-items:stretch;flex-direction:column}}</style>
