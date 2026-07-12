<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NDrawer, NDrawerContent, NTag, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ActionAuditEventDto, ActionJsonValue, ActionWorkflowAction, ActionWorkflowDetailDto } from '@/api/hermes/action-fabric'
import { useActionFabricMessages } from './action-fabric-messages'

const props = defineProps<{ show: boolean; workflow: ActionWorkflowDetailDto | null; audit: ActionAuditEventDto[]; saving: boolean }>()
type ConfirmationComplete = () => void
const emit = defineEmits<{
  close: []
  approve: [complete: ConfirmationComplete]
  reject: [reason: string, complete: ConfirmationComplete]
  retry: [complete: ConfirmationComplete]
  cancel: [reason: string, complete: ConfirmationComplete]
  compensate: [reason: string, complete: ConfirmationComplete]
}>()
const dialog = useDialog()
const { locale } = useI18n()
const { messages: m } = useActionFabricMessages(locale)
const reason = ref('')
const drawer = ref<HTMLElement | null>(null)
interface ActiveConfirmation { token: number; submitted: boolean; sawSaving: boolean }
const activeConfirmation = ref<ActiveConfirmation | null>(null)
const confirming = computed(() => activeConfirmation.value !== null)
let confirmationEpoch = 0
function actionAvailable(action: ActionWorkflowAction): boolean {
  return props.workflow?.availableActions?.[action] === true
}
const needsApproval = computed(() => actionAvailable('approve'))
const canReject = computed(() => actionAvailable('reject'))
const canRetry = computed(() => actionAvailable('retry'))
const canCancel = computed(() => actionAvailable('cancel'))
const canCompensate = computed(() => actionAvailable('compensate'))

watch(() => props.show, async show => {
  if (!show) { releaseActiveConfirmation(); return }
  reason.value = ''
  await nextTick()
  const first = drawer.value?.querySelector<HTMLButtonElement>('button:not([disabled])')
  if (first) first.focus(); else drawer.value?.focus()
})
watch([() => props.workflow?.id, () => props.workflow?.version], () => releaseActiveConfirmation())
watch(() => props.saving, saving => {
  const active = activeConfirmation.value
  if (!active?.submitted) return
  if (saving) active.sawSaving = true
  else if (active.sawSaving) releaseConfirmation(active.token)
})
onBeforeUnmount(() => releaseActiveConfirmation())

function boundedJson(value: ActionJsonValue | undefined): string {
  try { return JSON.stringify(value ?? null, null, 2).slice(0, 4000) } catch { return 'null' }
}
function releaseActiveConfirmation(): void {
  activeConfirmation.value = null
}
function releaseConfirmation(token: number): void {
  if (activeConfirmation.value?.token === token) activeConfirmation.value = null
}
function completeConfirmation(token: number): void {
  const active = activeConfirmation.value
  if (active?.token === token && active.submitted) releaseConfirmation(token)
}
function dismissConfirmation(token: number): void {
  const active = activeConfirmation.value
  if (active?.token === token && !active.submitted) releaseConfirmation(token)
}
function confirm(label: string, isAllowed: () => boolean, action: (complete: ConfirmationComplete) => void): void {
  if (!props.workflow || confirming.value) return
  const workflowId = props.workflow.id
  const workflowVersion = props.workflow.version
  const token = ++confirmationEpoch
  activeConfirmation.value = { token, submitted: false, sawSaving: false }
  try {
    dialog.warning({
      title: m.value.confirmTitle,
      content: `${m.value.confirmAction}: ${props.workflow.id}`,
      positiveText: label,
      negativeText: m.value.close,
      onPositiveClick: () => {
        const active = activeConfirmation.value
        if (active?.token !== token || active.submitted) return
        if (props.saving) { releaseConfirmation(token); return }
        if (props.workflow?.id !== workflowId || props.workflow.version !== workflowVersion || !isAllowed()) {
          releaseConfirmation(token)
          return
        }
        active.submitted = true
        action(() => completeConfirmation(token))
      },
      onNegativeClick: () => dismissConfirmation(token),
      onClose: () => dismissConfirmation(token),
    })
  } catch (cause) {
    releaseConfirmation(token)
    throw cause
  }
}
function withReason(label: string, isAllowed: () => boolean, action: (value: string, complete: ConfirmationComplete) => void): void {
  const value = reason.value.trim()
  if (!value) return
  confirm(label, isAllowed, complete => action(value, complete))
}
function closeDrawer(): void {
  releaseActiveConfirmation()
  emit('close')
}
</script>

<template>
  <NDrawer :show="show" :width="680" placement="right" @update:show="!$event && closeDrawer()">
    <NDrawerContent :title="m.workflow" closable>
      <section v-if="workflow" ref="drawer" data-test="workflow-drawer" class="detail" tabindex="-1" @keydown.esc.stop="closeDrawer">
        <button type="button" class="native-close" :aria-label="m.close" @click="closeDrawer">{{ m.close }}</button>
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
          <button v-if="needsApproval" data-test="approve-workflow" type="button" :disabled="saving || confirming" @click="confirm(m.approve, () => needsApproval, complete => emit('approve', complete))">{{ m.approve }}</button>
          <button v-if="canReject" data-test="reject-workflow" type="button" :disabled="saving || confirming || !reason.trim()" @click="withReason(m.reject, () => canReject, (value, complete) => emit('reject', value, complete))">{{ m.reject }}</button>
          <button v-if="canRetry" data-test="retry-workflow" type="button" :disabled="saving || confirming" @click="confirm(m.retry, () => canRetry, complete => emit('retry', complete))">{{ m.retry }}</button>
          <button v-if="canCancel" data-test="cancel-workflow" type="button" :disabled="saving || confirming || !reason.trim()" @click="withReason(m.cancel, () => canCancel, (value, complete) => emit('cancel', value, complete))">{{ m.cancel }}</button>
          <button v-if="canCompensate" data-test="compensate-workflow" type="button" :disabled="saving || confirming || !reason.trim()" @click="withReason(m.compensate, () => canCompensate, (value, complete) => emit('compensate', value, complete))">{{ m.compensate }}</button>
        </div>
      </section>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.detail { display:flex; flex-direction:column; gap:16px; outline:none; } .native-close { align-self:flex-end; } .summary { display:grid; grid-template-columns:max-content 1fr; gap:7px 12px; margin:0; } dt { font-weight:600; } dd { margin:0; overflow-wrap:anywhere; } h4,p { margin:0 0 8px; } pre { max-height:220px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; padding:10px; border-radius:8px; background:rgba(127,127,127,.08); font-size:12px; } ol,ul { padding-left:20px; } ol>li { margin-bottom:12px; } ol>li>span { display:block; } .reason { display:flex; flex-direction:column; gap:6px; } .actions { display:flex; flex-wrap:wrap; gap:8px; } button { padding:7px 12px; cursor:pointer; }
</style>
