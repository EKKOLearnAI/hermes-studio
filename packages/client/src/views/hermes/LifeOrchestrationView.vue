<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { NSpin, useMessage } from 'naive-ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import type { CreateLifeConstraintInput, LifeActivationLimitsInput, LifeMode, LifeSourceKind } from '@/api/hermes/life-orchestration'
import { useLifeOrchestrationStore } from '@/stores/hermes/life-orchestration'
import LifeTodayPanel from '@/components/hermes/life/LifeTodayPanel.vue'
import LifeSourcesPanel from '@/components/hermes/life/LifeSourcesPanel.vue'
import LifePlannerPanel from '@/components/hermes/life/LifePlannerPanel.vue'
import LifeLibraryPanel from '@/components/hermes/life/LifeLibraryPanel.vue'
import LifeSubscriptionsPanel from '@/components/hermes/life/LifeSubscriptionsPanel.vue'
import LifeWorkflowPanel from '@/components/hermes/life/LifeWorkflowPanel.vue'

const { t } = useI18n(); const message = useMessage(); const store = useLifeOrchestrationStore()
const { overview, commitments, contacts, options, subscriptions, constraints, plans, handoffs, holds,
  cancellations, workflows, takeovers, activationReviews, selectedSourceId, selectedPlanId, selectedWorkflowId,
  selectedSource, planMaterialChanged, loading, saving, error } = storeToRefs(store)
const canAdmin = computed(() => isStoredSuperAdmin())
const canOperate = computed(() => !overview.value?.runtime.emergencyStopped)
let pollHandle: number | null = null; let pollGeneration = 0

onMounted(loadDashboard)
onBeforeUnmount(() => { pollGeneration += 1; if (pollHandle !== null) window.clearInterval(pollHandle); store.reset() })

function operationId(kind: string) {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? Math.random().toString(36).slice(2)
  return `life-ui:${kind}:${Date.now().toString(36)}:${random}`
}
function common(kind: string, rationale: string) { return { idempotencyKey: operationId(kind), rationale } }
async function loadDashboard() {
  try { await store.loadDashboard(); if (selectedSourceId.value) await store.loadActivationReviews(selectedSourceId.value) }
  catch { message.error(t('life.errors.load')) }
}
function follow(id: string) {
  selectedWorkflowId.value = id; pollGeneration += 1; const generation = pollGeneration
  if (pollHandle !== null) window.clearInterval(pollHandle)
  const refresh = async () => {
    try { const workflow = await store.loadWorkflow(id)
      if (['succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated'].includes(workflow.state)) {
        if (pollHandle !== null) window.clearInterval(pollHandle); pollHandle = null; await store.loadDashboard()
      }
    } catch { if (pollHandle !== null) window.clearInterval(pollHandle); pollHandle = null }
  }
  void refresh(); pollHandle = window.setInterval(() => { if (generation === pollGeneration) void refresh() }, 1500)
}
async function queue(action: () => Promise<{ workflow: { id: string } }>) {
  try { const value = await action(); follow(value.workflow.id); message.success(t('life.success.queued')) }
  catch { message.error(t('life.errors.action')) }
}
function syncSource(id: string) { return queue(() => store.syncSource({ accountId: id, cursor: null, limit: 20,
  ...common('sync', 'Synchronize one bounded semantic life source page') })) }
async function createSource(value: { id: string; sourceKind: LifeSourceKind; mode: 'observe' | 'shadow'; displayName: string }) {
  if (!canAdmin.value) return; try { await store.createSource(value); await loadDashboard(); message.success(t('life.success.source')) }
  catch { message.error(t('life.errors.authority')) }
}
async function createConstraint(value: CreateLifeConstraintInput) {
  try { await store.createConstraint(value); message.success(t('life.success.constraint')) }
  catch { message.error(t('life.errors.plan')) }
}
async function createPlan(constraintSnapshotId: string) {
  try { await store.createPlan({ constraintSnapshotId, activeAt: new Date().toISOString(), maxOptions: 32, maxSessions: 8 }); message.success(t('life.success.plan')) }
  catch { message.error(t('life.errors.plan')) }
}
function verifyPlan(planRevisionId: string) { return queue(() => store.verifyPlan({ planRevisionId,
  activeAt: new Date().toISOString(), ...common('verify', 'Verify immutable leisure plan material') })) }
function createHold(value: { accountId: string; planRevisionId: string; optionId: string }) {
  return queue(() => store.createHold({ ...value, providerRequestId: operationId('hold-provider'),
    ...common('hold', 'Create the exact confirmed calendar hold') }))
}
function cancelSubscription(value: { subscriptionId: string; reasonCode: string }) {
  return queue(() => store.cancelSubscription({ ...value, providerRequestId: operationId('subscription-provider'),
    ...common('subscription-cancel', 'Cancel the exact reviewed subscription') }))
}
function cancelHold(holdId: string) { return queue(() => store.cancelHold({ holdId,
  providerRequestId: operationId('hold-cancel-provider'), reasonCode: 'USER_CANCELLED',
  ...common('hold-cancel', 'Cancel the exact confirmed calendar hold') })) }
async function selectSource(id: string) { try { await store.selectSource(id) } catch { message.error(t('life.errors.load')) } }
async function selectWorkflow(id: string) { try { await store.loadWorkflow(id) } catch { message.error(t('life.errors.workflow')) } }
async function reviewWorkflow(value: { id: string; action: 'approve' | 'reject'; reason: string }) {
  if (!canAdmin.value) return; try { const workflow = await store.reviewWorkflow(value.id, value.action, value.reason); follow(workflow.id); message.success(t('life.success.reviewed')) }
  catch { message.error(t('life.errors.workflow')) }
}
async function updateHealth(health: 'unknown' | 'healthy' | 'degraded' | 'unhealthy') {
  if (!selectedSource.value || !canAdmin.value) return
  try { await store.updateHealth(selectedSource.value.id, health, selectedSource.value.version); await loadDashboard() }
  catch { message.error(t('life.errors.authority')) }
}
async function activate(value: { toMode: LifeMode; limits: LifeActivationLimitsInput }) {
  if (!selectedSource.value || !canAdmin.value) return
  try { await store.activate(selectedSource.value.id, value.toMode, value.limits); await loadDashboard(); message.success(t('life.success.activated')) }
  catch { message.error(t('life.errors.authority')) }
}
async function revoke() {
  if (!selectedSource.value || !canAdmin.value) return
  try { await store.revoke(selectedSource.value.id, selectedSource.value.version); await loadDashboard(); message.success(t('life.success.revoked')) }
  catch { message.error(t('life.errors.authority')) }
}
</script>

<template>
  <main class="life-view" data-test="life-command-center"><header class="page-header"><div><h1>{{ t('life.title') }}</h1><p>{{ t('life.subtitle') }}</p></div>
    <button :disabled="loading" data-test="life-dashboard-refresh" @click="loadDashboard">{{ t('life.refresh') }}</button></header>
    <p v-if="!canAdmin" class="read-only">{{ t('life.adminBoundary') }}</p><p v-if="error" class="error" role="alert">{{ error }}</p>
    <NSpin :show="loading && !overview"><div class="grid">
      <LifeTodayPanel class="wide" :overview="overview" :commitments="commitments" :plans="plans" :holds="holds" @plan="selectedPlanId = $event" />
      <LifeSourcesPanel :sources="overview?.accounts ?? []" :selected-id="selectedSourceId" :reviews="activationReviews"
        :can-admin="canAdmin" :can-operate="canOperate" :busy="saving" @select="selectSource" @sync="syncSource" @create="createSource"
        @health="updateHealth" @activate="activate" @revoke="revoke" />
      <LifePlannerPanel :constraints="constraints" :plans="plans" :selected-plan-id="selectedPlanId" :options="options"
        :sources="overview?.accounts ?? []" :material-changed="planMaterialChanged" :can-write="canOperate" :busy="saving"
        @select="selectedPlanId = $event" @constraint="createConstraint" @plan="createPlan" @verify="verifyPlan" @hold="createHold" />
      <LifeLibraryPanel :options="options" :contacts="contacts" :handoffs="handoffs" />
      <LifeSubscriptionsPanel :subscriptions="subscriptions" :cancellations="cancellations" :can-write="canOperate"
        :busy="saving" @cancel="cancelSubscription" />
      <LifeWorkflowPanel class="wide" :workflows="workflows" :takeovers="takeovers" :holds="holds"
        :selected-id="selectedWorkflowId" :can-review="canAdmin" :can-write="canOperate" :busy="saving" @select="selectWorkflow"
        @review="reviewWorkflow" @cancel-hold="cancelHold" />
    </div></NSpin>
  </main>
</template>

<style scoped>
.life-view{height:100%;min-height:0;overflow:auto;padding:24px;color:var(--text-color)}.page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.page-header h1{margin:0;font-size:25px}.page-header p{margin:5px 0 0;color:var(--text-color-2)}.page-header button{padding:7px 12px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit}.read-only,.error{margin:0 0 12px;padding:10px 12px;border-radius:7px}.read-only{background:color-mix(in srgb,var(--warning-color) 10%,transparent);color:var(--warning-color)}.error{background:color-mix(in srgb,var(--error-color) 10%,transparent);color:var(--error-color)}.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}.wide{grid-column:1/-1}@media(max-width:980px){.grid{grid-template-columns:1fr}.wide{grid-column:1}}@media(max-width:600px){.life-view{padding:16px}.page-header{flex-direction:column}}
</style>
