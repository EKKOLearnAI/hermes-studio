<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CommerceTransactionDetailDto, CommerceTransactionDto } from '@/api/hermes/commerce'

const props = defineProps<{ transactions: CommerceTransactionDto[]; detail: CommerceTransactionDetailDto | null
  canWrite: boolean; busy: boolean }>()
const emit = defineEmits<{ select: [id: string]; payment: [value: { transactionId: string; approvalId: string }]
  delivery: [transactionId: string]; cancel: [value: { transactionId: string; reasonCode: string }]
  refund: [value: { transactionId: string; reasonCode: string; amountMinor: number }] }>()
const { t } = useI18n()
const approvalId = ref('')
const reasonCode = ref('USER_REQUESTED')
const refundMinor = ref<number | null>(null)
const confirmPayment = ref(false)
const transaction = computed(() => props.detail?.transaction ?? null)
const timeline = computed(() => {
  if (!props.detail) return []
  return [
    ...props.detail.checkpoints.map(item => ({ at: item.observedAt, label: item.stage, state: item.errorCode ?? 'verified' })),
    ...props.detail.delivery.map(item => ({ at: item.observedAt, label: `delivery.${item.state}`, state: item.state })),
    ...props.detail.cancellations.map(item => ({ at: item.updatedAt, label: 'cancellation', state: item.state })),
    ...props.detail.refunds.map(item => ({ at: item.updatedAt, label: 'refund', state: item.state })),
  ].sort((a, b) => a.at.localeCompare(b.at))
})
const canPay = computed(() => props.canWrite && !props.busy && !!transaction.value
  && ['waiting_payment', 'order_pending'].includes(transaction.value.state)
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(approvalId.value))
const validReason = computed(() => /^[A-Z][A-Z0-9_]{1,127}$/.test(reasonCode.value))
function money(amount: number | null, currency: string) { return `${currency} ${((amount ?? 0) / 100).toFixed(2)}` }
function requestCancel() { if (transaction.value) emit('cancel', { transactionId: transaction.value.id, reasonCode: reasonCode.value }) }
function requestRefund() { if (transaction.value && refundMinor.value !== null) emit('refund', { transactionId: transaction.value.id,
  reasonCode: reasonCode.value, amountMinor: refundMinor.value }) }
</script>

<template>
  <section class="panel" data-test="commerce-transaction-panel">
    <header><div><h2>{{ t('commerce.transaction.title') }}</h2><p>{{ t('commerce.transaction.summary') }}</p></div></header>
    <div class="layout">
      <nav><button v-for="item in transactions" :key="item.id" type="button" :class="{ selected: item.id === transaction?.id }"
        :data-test="`commerce-transaction-${item.id}`" @click="emit('select', item.id)"><strong>{{ item.providerOrderId ?? item.id }}</strong>
        <span>{{ t(`commerce.transactionState.${item.state}`) }} · {{ money(item.actualAmountMinor ?? item.expectedAmountMinor, item.currency) }}</span></button>
        <p v-if="!transactions.length" class="empty">{{ t('commerce.transaction.empty') }}</p></nav>
      <div class="detail" v-if="transaction">
        <div class="facts"><div><span>{{ t('commerce.transaction.state') }}</span><strong>{{ t(`commerce.transactionState.${transaction.state}`) }}</strong></div>
          <div><span>{{ t('commerce.transaction.amount') }}</span><strong>{{ money(transaction.actualAmountMinor ?? transaction.expectedAmountMinor, transaction.currency) }}</strong></div>
          <div><span>{{ t('commerce.transaction.mode') }}</span><strong>{{ t(`commerce.mode.${transaction.mode}`) }}</strong></div>
          <div><span>{{ t('commerce.transaction.policyEpoch') }}</span><strong>{{ transaction.policyEpoch }}</strong></div></div>
        <div class="timeline"><article v-for="(item,index) in timeline" :key="`${item.at}:${index}`"><i></i><div><strong>{{ item.label }}</strong><span>{{ item.state }} · {{ item.at }}</span></div></article>
          <p v-if="!timeline.length" class="empty">{{ t('commerce.transaction.noTimeline') }}</p></div>
        <div class="controls">
          <label>{{ t('commerce.transaction.approval') }}<input v-model="approvalId" autocomplete="off" data-test="commerce-payment-approval"></label>
          <button :disabled="!canPay" data-test="commerce-open-payment-confirmation" @click="confirmPayment = true">{{ t('commerce.transaction.pay') }}</button>
          <button :disabled="!canWrite || busy" data-test="commerce-track-delivery" @click="emit('delivery', transaction.id)">{{ t('commerce.transaction.track') }}</button>
          <label>{{ t('commerce.transaction.reason') }}<input v-model="reasonCode" pattern="[A-Z][A-Z0-9_]+"></label>
          <button :disabled="!canWrite || busy || !validReason" data-test="commerce-cancel-order" @click="requestCancel">{{ t('commerce.transaction.cancelOrder') }}</button>
          <label>{{ t('commerce.transaction.refundAmount') }}<input v-model.number="refundMinor" type="number" min="0" :max="transaction.actualAmountMinor ?? transaction.expectedAmountMinor"></label>
          <button :disabled="!canWrite || busy || refundMinor === null || !validReason" data-test="commerce-request-refund" @click="requestRefund">{{ t('commerce.transaction.refund') }}</button>
        </div>
      </div>
      <p v-else class="empty">{{ t('commerce.transaction.select') }}</p>
    </div>
    <div v-if="confirmPayment && transaction" class="dialog-backdrop" data-test="commerce-payment-confirmation">
      <section class="dialog" role="dialog" aria-modal="true"><h3>{{ t('commerce.payment.title') }}</h3>
        <p>{{ t('commerce.payment.summary') }}</p><dl><div><dt>{{ t('commerce.payment.order') }}</dt><dd>{{ transaction.providerOrderId }}</dd></div>
          <div><dt>{{ t('commerce.payment.amount') }}</dt><dd>{{ money(transaction.expectedAmountMinor, transaction.currency) }}</dd></div>
          <div><dt>{{ t('commerce.payment.approval') }}</dt><dd>{{ approvalId }}</dd></div></dl>
        <p class="warning">{{ t('commerce.payment.warning') }}</p><footer><button @click="confirmPayment = false">{{ t('commerce.common.cancel') }}</button>
          <button class="primary" data-test="commerce-confirm-payment" @click="emit('payment', { transactionId: transaction.id, approvalId }); confirmPayment = false">{{ t('commerce.payment.submit') }}</button></footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.panel{padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color)}h2{margin:0}header p,.empty{color:var(--text-color-3)}header p{margin:4px 0 14px}.layout{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(0,2fr);gap:14px}nav{max-height:430px;overflow:auto}nav button{display:block;width:100%;padding:10px;border:0;border-bottom:1px solid var(--border-color);background:transparent;color:inherit;text-align:left;cursor:pointer}nav button.selected{background:var(--hover-color);color:var(--primary-color)}nav strong,nav span{display:block}nav span{margin-top:3px;color:var(--text-color-3);font-size:11px}.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.facts div{padding:9px;border-radius:8px;background:var(--hover-color)}.facts span,.facts strong{display:block}.facts span{font-size:11px;color:var(--text-color-3)}.timeline{margin:12px 0;max-height:220px;overflow:auto}.timeline article{display:flex;gap:9px;padding:7px}.timeline i{width:8px;height:8px;margin-top:5px;border-radius:50%;background:var(--primary-color)}.timeline strong,.timeline span{display:block}.timeline span{font-size:11px;color:var(--text-color-3)}.controls{display:grid;grid-template-columns:2fr auto auto;gap:8px;align-items:end}.controls label{font-size:11px;color:var(--text-color-3)}input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:7px;border:1px solid var(--border-color);border-radius:7px;background:var(--input-color);color:inherit}button{padding:8px 11px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit;cursor:pointer}button:disabled{opacity:.45}.primary{background:var(--primary-color);color:#fff;border-color:transparent}.dialog-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:#0008}.dialog{width:min(480px,100%);padding:20px;border-radius:12px;background:var(--card-color)}.dialog h3{margin-top:0}.dialog dl div{display:grid;grid-template-columns:120px 1fr;padding:7px 0;border-top:1px solid var(--border-color)}dd{margin:0;overflow-wrap:anywhere}.warning{padding:10px;border-radius:8px;background:color-mix(in srgb,var(--error-color) 10%,transparent);color:var(--error-color)}footer{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:850px){.layout{grid-template-columns:1fr}.facts{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.controls{grid-template-columns:1fr}}
</style>
