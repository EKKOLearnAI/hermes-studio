<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NDrawer, NDrawerContent, NTag, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ActionAuditEventDto, ActionCapabilityDto, ActionJsonValue, ActionWorkflowDetailDto } from '@/api/hermes/action-fabric'
import { useActionFabricMessages } from './action-fabric-messages'

const props = defineProps<{ show: boolean; workflow: ActionWorkflowDetailDto | null; capability: ActionCapabilityDto | null; audit: ActionAuditEventDto[]; saving: boolean }>()
const emit = defineEmits<{ close: []; approve: []; reject: [reason: string]; retry: []; cancel: [reason: string]; compensate: [reason: string] }>()
const dialog = useDialog()
const { locale } = useI18n()
const { messages: m } = useActionFabricMessages(locale)
const reason = ref('')
const drawer = ref<HTMLElement | null>(null)
const needsApproval = computed(() => props.workflow?.state === 'waiting_user')
const canRetry = computed(() => props.workflow?.state === 'failed' || props.workflow?.state === 'dead_letter')
const canCancel = computed(() => Boolean(props.workflow && ['draft', 'policy_check', 'preparing', 'executing', 'verifying', 'waiting_user', 'retrying'].includes(props.workflow.state)))
const canCompensate = computed(() => Boolean(props.workflow?.state === 'succeeded' && props.capability?.reversible && !props.workflow.compensationIntentId))

watch(() => props.show, async show => {
  if (!show) return
  reason.value = ''
  await nextTick()
  const first = drawer.value?.querySelector<HTMLButtonElement>('button:not([disabled])')
  if (first) first.focus(); else drawer.value?.focus()
})

function boundedJson(value: ActionJsonValue | undefined): string {
  try { return JSON.stringify(value ?? null, null, 2).slice(0, 4000) } catch { return 'null' }
}
function confirm(label: string, action: () => void): void {
  if (!props.workflow) return
  dialog.warning({ title: m.value.confirmTitle, content: `${m.value.confirmAction}: ${props.workflow.id}`, positiveText: label, negativeText: m.value.close, onPositiveClick: action })
}
function withReason(label: string, action: (value: string) => void): void {
  const value = reason.value.trim()
  if (!value) return
  confirm(label, () => action(value))
}
</script>

<template>
  <NDrawer :show="show" :width="680" placement="right" @update:show="!$event && emit('close')">
    <NDrawerContent :title="m.workflow" closable>
      <section v-if="workflow" ref="drawer" data-test="workflow-drawer" class="detail" tabindex="-1" @keydown.esc.stop="emit('close')">
        <button type="button" class="native-close" :aria-label="m.close" @click="emit('close')">{{ m.close }}</button>
        <dl class="summary">
          <dt>{{ m.workflow }}</dt><dd>{{ workflow.id }}</dd><dt>{{ m.role }}</dt><dd>{{ workflow.requestedByRoleId }}</dd>
          <dt>{{ m.capability }}</dt><dd>{{ workflow.capabilityId }}</dd><dt>{{ m.executor }}</dt><dd>{{ workflow.executorId || '—' }}</dd>
          <dt>{{ m.state }}</dt><dd><NTag>{{ workflow.state }}</NTag></dd>
        </dl>
        <section><h4>{{ m.policyReasons }}</h4><p v-if="!workflow.policyDecision">{{ m.noPolicy }}</p><ul v-else><li v-for="(code, codeIndex) in workflow.policyDecision.reasonCodes.slice(0, 50)" :key="`${code}-${codeIndex}`">{{ code }}</li></ul><pre>{{ boundedJson(workflow.policyDecision?.sanitizedSummary) }}</pre></section>
        <section><h4>{{ m.sanitizedSummary }}</h4><pre>{{ boundedJson(workflow.intent.sanitizedSummary) }}</pre></section>
        <section><h4>{{ m.steps }}</h4><p v-if="!workflow.steps.length">{{ m.noSteps }}</p><ol v-else><li v-for="step in workflow.steps.slice(0, 100)" :key="step.id"><strong>{{ step.ordinal }} · {{ step.kind }} · {{ step.state }}</strong><span>{{ m.attempt }} {{ step.attempt }}</span><span v-if="step.lastErrorCode">{{ m.lastError }}: {{ step.lastErrorCode }}</span><ul><li v-for="(item, evidenceIndex) in step.evidence.slice(0, 50)" :key="`${step.id}-evidence-${evidenceIndex}`"><strong>{{ item.kind }}</strong> — {{ item.summary }}<pre>{{ boundedJson(item.data) }}</pre></li></ul></li></ol></section>
        <section><h4>{{ m.retryHistory }}</h4><p>{{ m.attempt }} {{ workflow.attempt }} / {{ workflow.maxAttempts }}</p><p>{{ m.lastError }}: {{ workflow.lastErrorCode || '—' }}</p><p>{{ m.retryAt }}: {{ workflow.retryAt || '—' }}</p></section>
        <section><h4>{{ m.auditReferences }}</h4><p v-if="!audit.length">{{ m.noAudit }}</p><ul v-else><li v-for="event in audit.slice(0, 100)" :key="event.id">#{{ event.sequence }} · {{ event.eventType }} · {{ event.id }}</li></ul></section>
        <p v-if="canCompensate" data-test="compensation-eligible" role="status">{{ m.compensationEligible }}</p><p v-else>{{ m.compensationUnavailable }}</p>
        <label class="reason">{{ m.reason }}<input v-model="reason" data-test="action-reason" type="text" maxlength="500"></label>
        <div class="actions" aria-label="Workflow actions">
          <button v-if="needsApproval" data-test="approve-workflow" type="button" :disabled="saving" @click="confirm(m.approve, () => emit('approve'))">{{ m.approve }}</button>
          <button v-if="needsApproval" data-test="reject-workflow" type="button" :disabled="saving || !reason.trim()" @click="withReason(m.reject, value => emit('reject', value))">{{ m.reject }}</button>
          <button v-if="canRetry" data-test="retry-workflow" type="button" :disabled="saving" @click="confirm(m.retry, () => emit('retry'))">{{ m.retry }}</button>
          <button v-if="canCancel" data-test="cancel-workflow" type="button" :disabled="saving || !reason.trim()" @click="withReason(m.cancel, value => emit('cancel', value))">{{ m.cancel }}</button>
          <button v-if="canCompensate" data-test="compensate-workflow" type="button" :disabled="saving || !reason.trim()" @click="withReason(m.compensate, value => emit('compensate', value))">{{ m.compensate }}</button>
        </div>
      </section>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.detail { display:flex; flex-direction:column; gap:16px; outline:none; } .native-close { align-self:flex-end; } .summary { display:grid; grid-template-columns:max-content 1fr; gap:7px 12px; margin:0; } dt { font-weight:600; } dd { margin:0; overflow-wrap:anywhere; } h4,p { margin:0 0 8px; } pre { max-height:220px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; padding:10px; border-radius:8px; background:rgba(127,127,127,.08); font-size:12px; } ol,ul { padding-left:20px; } ol>li { margin-bottom:12px; } ol>li>span { display:block; } .reason { display:flex; flex-direction:column; gap:6px; } .actions { display:flex; flex-wrap:wrap; gap:8px; } button { padding:7px 12px; cursor:pointer; }
</style>
