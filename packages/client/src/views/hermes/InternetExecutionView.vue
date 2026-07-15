<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import { useInternetExecutionStore } from '@/stores/hermes/internet-execution'
import type { InternetReceiptDto, InternetSearchOrder, InternetWorkflowState } from '@/api/hermes/internet-execution'
import InternetStatusPanel from '@/components/hermes/internet-execution/InternetStatusPanel.vue'
import InternetIntentPanel from '@/components/hermes/internet-execution/InternetIntentPanel.vue'
import InternetResultPanel from '@/components/hermes/internet-execution/InternetResultPanel.vue'
import InternetWorkflowPanel from '@/components/hermes/internet-execution/InternetWorkflowPanel.vue'

const { t } = useI18n()
const message = useMessage()
const store = useInternetExecutionStore()
const { overview, receipts, selectedReceipt, evidence, selectedWorkflow, takeoverRequired,
  loading, saving, error } = storeToRefs(store)
const canWrite = computed(() => isStoredSuperAdmin())
const runtimeAvailable = computed(() => overview.value?.provider.executorEnabled === true)
const terminalStates = new Set<InternetWorkflowState>([
  'succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated',
])
let pollHandle: number | null = null
let pollSequence = 0

onMounted(loadDashboard)
onBeforeUnmount(stopPolling)

async function loadDashboard() {
  try {
    await store.loadDashboard()
    if (!store.selectedWorkflowId && store.receipts[0]) await selectReceipt(store.receipts[0])
  } catch { message.error(t('internetExecution.errors.load')) }
}
function operationId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16)
    ?? Math.random().toString(16).slice(2, 18)
  return `internet-ui:${prefix}:${Date.now().toString(36)}:${random}`
}
function stopPolling() {
  pollSequence += 1
  if (pollHandle !== null) window.clearInterval(pollHandle)
  pollHandle = null
}
async function refreshSelection() {
  const id = store.selectedWorkflowId
  if (!id) return
  try {
    const workflow = await store.loadWorkflow(id)
    if (!['draft', 'policy_check', 'preparing'].includes(workflow.state)) {
      await store.loadReceipt(id).catch(() => store.clearResourceError('receipt'))
    }
    if (terminalStates.has(workflow.state) || workflow.state === 'waiting_user') {
      stopPolling()
      await Promise.allSettled([store.loadOverview(), store.loadReceipts()])
    }
  } catch { stopPolling() }
}
function followWorkflow(id: string) {
  stopPolling()
  store.selectWorkflow(id)
  const sequence = pollSequence
  void refreshSelection()
  pollHandle = window.setInterval(() => {
    if (sequence !== pollSequence) return
    void refreshSelection()
  }, 1_500)
}
async function queueAction(action: () => Promise<{ workflow: { id: string } }>) {
  try {
    const result = await action()
    followWorkflow(result.workflow.id)
    message.success(t('internetExecution.success.queued'))
  } catch { message.error(t('internetExecution.errors.execute')) }
}
async function search(input: { query: string; limit: number; page: number; order: InternetSearchOrder }) {
  await queueAction(() => store.search({ ...input, idempotencyKey: operationId('search') }))
}
async function inspect(input: { bvid: string }) {
  await queueAction(() => store.inspect({ ...input, idempotencyKey: operationId('inspect') }))
}
async function selectReceipt(receipt: InternetReceiptDto) {
  stopPolling()
  store.selectReceipt(receipt)
  await Promise.allSettled([store.loadReceipt(receipt.workflowId), store.loadWorkflow(receipt.workflowId)])
}
</script>

<template>
  <main class="internet-view" data-test="internet-execution-center">
    <header class="page-header"><div><h1>{{ t('internetExecution.title') }}</h1><p>{{ t('internetExecution.subtitle') }}</p></div>
      <button :disabled="loading" data-test="internet-dashboard-refresh" @click="loadDashboard">{{ t('internetExecution.refresh') }}</button></header>
    <p v-if="error" class="load-error" role="alert">{{ error }}</p>
    <NSpin :show="loading && !overview">
      <div class="internet-layout">
        <InternetStatusPanel class="status" :overview="overview" />
        <InternetIntentPanel :can-write="canWrite" :busy="saving" :available="runtimeAvailable" @search="search" @inspect="inspect" />
        <InternetWorkflowPanel :workflow="selectedWorkflow" :takeover-required="takeoverRequired" :busy="loading" @refresh="refreshSelection" />
        <InternetResultPanel class="result" :receipts="receipts" :selected="selectedReceipt" :evidence="evidence" @select="selectReceipt" />
      </div>
    </NSpin>
  </main>
</template>

<style scoped lang="scss">
.internet-view { height: 100%; min-height: 0; overflow: auto; padding: 24px; color: var(--text-color); }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 25px; }.page-header p { margin: 5px 0 0; color: var(--text-color-2); }.page-header button { padding: 7px 12px; border: 1px solid var(--border-color); border-radius: 7px; background: transparent; color: var(--text-color); cursor: pointer; }.page-header button:disabled { opacity: .5; }
.load-error { margin: 0 0 14px; padding: 10px 12px; border-radius: 7px; background: color-mix(in srgb, var(--error-color) 10%, transparent); color: var(--error-color); }
.internet-layout { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(0, 1.45fr); gap: 14px; align-items: start; }.status,.result { grid-column: 1 / -1; }
@media (max-width: 900px) { .internet-layout { grid-template-columns: 1fr; }.status,.result { grid-column: 1; } }
@media (max-width: 600px) { .internet-view { padding: 16px; }.page-header { align-items: stretch; flex-direction: column; } }
</style>
