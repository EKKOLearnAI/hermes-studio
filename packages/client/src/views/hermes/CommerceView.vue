<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import { useCommerceStore } from '@/stores/hermes/commerce'
import type { CommerceMode } from '@/api/hermes/commerce'
import CommerceStatusPanel from '@/components/hermes/commerce/CommerceStatusPanel.vue'
import CommercePlanPanel from '@/components/hermes/commerce/CommercePlanPanel.vue'
import CommerceTransactionPanel from '@/components/hermes/commerce/CommerceTransactionPanel.vue'
import CommerceGovernancePanel from '@/components/hermes/commerce/CommerceGovernancePanel.vue'

const { t } = useI18n()
const message = useMessage()
const store = useCommerceStore()
const { overview, offers, comparisons, carts, quotes, workflows, transactions, takeovers,
  activationReviews, selectedAccountId, selectedAccount, transactionDetail, loading, saving, error } = storeToRefs(store)
const canAdmin = computed(() => isStoredSuperAdmin())
const canOperate = true
const terminal = new Set(['succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated', 'waiting_user'])
let pollHandle: number | null = null
let pollGeneration = 0

onMounted(loadDashboard)
onBeforeUnmount(stopPolling)

function operationId(kind: string) {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16)
    ?? Math.random().toString(16).slice(2, 18)
  return `commerce-ui:${kind}:${Date.now().toString(36)}:${random}`
}
const common = (kind: string, rationale: string) => ({ idempotencyKey: operationId(kind), rationale })
async function loadDashboard() {
  try { await store.loadDashboard(); await store.loadActivationReviews().catch(() => undefined) }
  catch { message.error(t('commerce.errors.load')) }
}
async function selectAccount(id: string) {
  if (!id) return
  try { await store.selectAccount(id); await store.loadActivationReviews(id) }
  catch { message.error(t('commerce.errors.load')) }
}
function stopPolling() { pollGeneration += 1; if (pollHandle !== null) window.clearInterval(pollHandle); pollHandle = null }
async function refreshWorkflow(id: string) {
  try {
    const workflow = await store.loadWorkflow(id)
    if (terminal.has(workflow.state)) { stopPolling(); await store.loadDashboard(); await store.loadActivationReviews().catch(() => undefined) }
  } catch { stopPolling() }
}
function follow(id: string) {
  stopPolling(); store.selectWorkflow(id); const generation = pollGeneration
  void refreshWorkflow(id)
  pollHandle = window.setInterval(() => { if (generation === pollGeneration) void refreshWorkflow(id) }, 1500)
}
async function queue(action: () => Promise<{ workflow: { id: string } }>) {
  try { const value = await action(); follow(value.workflow.id); message.success(t('commerce.success.queued')) }
  catch { message.error(t('commerce.errors.action')) }
}
function search(value: { accountId: string; query: string; limit: number }) {
  return queue(() => store.search({ ...value, ...common('search', 'Authenticated product search') }))
}
function compare(value: { accountId: string; query: string; quantity: number; maxTotalMinor: number | null }) {
  return queue(() => store.compare({ accountId: value.accountId, activeAt: new Date().toISOString(),
    requirement: { query: value.query, quantity: value.quantity, maxTotalMinor: value.maxTotalMinor,
      deliveryBefore: null, excludedMerchantIds: [], preferenceCodes: ['lowest_price', 'fast_delivery'] },
    ...common('compare', 'Compare normalized offers') }))
}
function createCart(value: { comparisonId: string; destinationToken: string; recipientToken: string; substitution: 'deny' | 'same_sku_only' }) {
  return queue(() => store.createCart({ ...value, ...common('cart', 'Prepare an immutable proposed cart') }))
}
function createQuote(cartRevisionId: string) {
  return queue(() => store.createQuote({ cartRevisionId, providerRequestId: operationId('quote-provider'),
    ...common('quote', 'Refresh and verify the exact quote') }))
}
function placeOrder(quoteId: string) {
  return queue(() => store.placeOrder({ quoteId, providerRequestId: operationId('order-provider'),
    ...common('order', 'Submit the exact confirmed order') }))
}
function confirmPayment(value: { transactionId: string; approvalId: string }) {
  return queue(() => store.confirmPayment({ ...value, ...common('payment', 'Confirm the fresh exact payment') }))
}
function trackDelivery(transactionId: string) {
  return queue(() => store.trackDelivery({ transactionId, ...common('delivery', 'Refresh exact delivery state') }))
}
function cancelOrder(value: { transactionId: string; reasonCode: string }) {
  return queue(() => store.cancelOrder({ ...value, providerRequestId: operationId('cancel-provider'),
    ...common('cancel', 'Request eligible order cancellation') }))
}
function requestRefund(value: { transactionId: string; reasonCode: string; amountMinor: number }) {
  return queue(() => store.requestRefund({ ...value, providerRequestId: operationId('refund-provider'),
    ...common('refund', 'Request bounded eligible refund') }))
}
async function selectTransaction(id: string) { try { await store.selectTransaction(id) } catch { message.error(t('commerce.errors.transaction')) } }
async function selectWorkflow(id: string) { try { await store.loadWorkflow(id) } catch { message.error(t('commerce.errors.workflow')) } }
async function reviewWorkflow(value: { id: string; action: 'approve' | 'reject'; reason: string }) {
  if (!canAdmin.value) return
  try { const workflow = await store.reviewWorkflow(value.id, value.action, value.reason); follow(workflow.id); message.success(t('commerce.success.reviewed')) }
  catch { message.error(t('commerce.errors.workflow')) }
}
async function activate(value: { toMode: CommerceMode; limits: Parameters<typeof store.activate>[2] }) {
  if (!selectedAccount.value || !canAdmin.value) return
  try { await store.activate(selectedAccount.value.id, value.toMode, value.limits); await loadDashboard(); message.success(t('commerce.success.activated')) }
  catch { message.error(t('commerce.errors.activation')) }
}
async function markHealth(health: 'unknown' | 'healthy' | 'degraded' | 'unhealthy') {
  if (!selectedAccount.value || !canAdmin.value) return
  try { await store.updateHealth(selectedAccount.value.id, health, selectedAccount.value.version); await loadDashboard() }
  catch { message.error(t('commerce.errors.activation')) }
}
async function revoke() {
  if (!selectedAccount.value || !canAdmin.value) return
  try { await store.revoke(selectedAccount.value.id, selectedAccount.value.version); await loadDashboard(); message.success(t('commerce.success.revoked')) }
  catch { message.error(t('commerce.errors.activation')) }
}
</script>

<template>
  <main class="commerce-view" data-test="commerce-command-center">
    <header class="page-header"><div><h1>{{ t('commerce.title') }}</h1><p>{{ t('commerce.subtitle') }}</p></div>
      <button :disabled="loading" data-test="commerce-dashboard-refresh" @click="loadDashboard">{{ t('commerce.refresh') }}</button></header>
    <p v-if="!canAdmin" class="read-only">{{ t('commerce.adminBoundary') }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <NSpin :show="loading && !overview"><div class="grid">
      <CommerceStatusPanel class="wide" :overview="overview" @account="selectAccount" />
      <CommercePlanPanel :accounts="overview?.accounts ?? []" :selected-account-id="selectedAccountId"
        :offers="offers" :comparisons="comparisons" :carts="carts" :quotes="quotes"
        :can-write="canOperate" :busy="saving" @account="selectAccount" @search="search" @compare="compare"
        @cart="createCart" @quote="createQuote" @order="placeOrder" />
      <CommerceGovernancePanel :account="selectedAccount" :reviews="activationReviews" :workflows="workflows"
        :takeovers="takeovers" :can-write="canAdmin" :busy="saving" @activate="activate" @health="markHealth"
        @revoke="revoke" @select-workflow="selectWorkflow" @review-workflow="reviewWorkflow" />
      <CommerceTransactionPanel class="wide" :transactions="transactions" :detail="transactionDetail"
        :can-write="canOperate" :busy="saving" @select="selectTransaction" @payment="confirmPayment"
        @delivery="trackDelivery" @cancel="cancelOrder" @refund="requestRefund" />
    </div></NSpin>
  </main>
</template>

<style scoped>
.commerce-view{height:100%;min-height:0;overflow:auto;padding:24px;color:var(--text-color)}.page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.page-header h1{margin:0;font-size:25px}.page-header p{margin:5px 0 0;color:var(--text-color-2)}.page-header button{padding:7px 12px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit;cursor:pointer}.page-header button:disabled{opacity:.5}.read-only,.error{margin:0 0 12px;padding:10px 12px;border-radius:7px}.read-only{background:color-mix(in srgb,var(--warning-color) 10%,transparent);color:var(--warning-color)}.error{background:color-mix(in srgb,var(--error-color) 10%,transparent);color:var(--error-color)}.grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(330px,1fr);gap:14px;align-items:start}.wide{grid-column:1/-1}@media(max-width:980px){.grid{grid-template-columns:1fr}.wide{grid-column:1}}@media(max-width:600px){.commerce-view{padding:16px}.page-header{flex-direction:column}}
</style>
