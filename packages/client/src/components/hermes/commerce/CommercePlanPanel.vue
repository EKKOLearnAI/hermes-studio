<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CommerceAccountDto, CommerceCartDto, CommerceComparisonDto, CommerceOfferDto,
  CommerceQuoteDto } from '@/api/hermes/commerce'

const props = defineProps<{ accounts: CommerceAccountDto[]; selectedAccountId: string | null
  offers: CommerceOfferDto[]; comparisons: CommerceComparisonDto[]; carts: CommerceCartDto[]
  quotes: CommerceQuoteDto[]; canWrite: boolean; busy: boolean }>()
const emit = defineEmits<{
  account: [id: string]; search: [value: { accountId: string; query: string; limit: number }]
  compare: [value: { accountId: string; query: string; quantity: number; maxTotalMinor: number | null }]
  cart: [value: { comparisonId: string; destinationToken: string; recipientToken: string; substitution: 'deny' | 'same_sku_only' }]
  quote: [cartRevisionId: string]; order: [quoteId: string]
}>()
const { t } = useI18n()
const query = ref('')
const quantity = ref(1)
const maxTotalMinor = ref<number | null>(null)
const destinationToken = ref('')
const recipientToken = ref('')
const substitution = ref<'deny' | 'same_sku_only'>('deny')
const confirmQuote = ref<CommerceQuoteDto | null>(null)
const account = computed(() => props.accounts.find(item => item.id === props.selectedAccountId) ?? null)
const latestComparison = computed(() => props.comparisons[0] ?? null)
const latestCart = computed(() => props.carts[0] ?? null)
const activeQuote = computed(() => props.quotes.find(item => item.status === 'active') ?? null)
const selectedOffer = computed(() => props.offers.find(item => item.id === latestComparison.value?.selectedOfferSnapshotId) ?? null)
const canAct = computed(() => props.canWrite && !props.busy && !!account.value && account.value.health !== 'revoked')
const opaqueToken = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const canCreateCart = computed(() => canAct.value && !!latestComparison.value?.selectedOfferSnapshotId
  && opaqueToken.test(destinationToken.value) && opaqueToken.test(recipientToken.value))
function money(amount: number, currency: string) { return `${currency} ${(amount / 100).toFixed(2)}` }
function search() { if (canAct.value && query.value.trim()) emit('search', { accountId: account.value!.id, query: query.value.trim(), limit: 20 }) }
function compare() { if (canAct.value && query.value.trim()) emit('compare', { accountId: account.value!.id,
  query: query.value.trim(), quantity: quantity.value, maxTotalMinor: maxTotalMinor.value }) }
function cart() { if (canCreateCart.value) emit('cart', { comparisonId: latestComparison.value!.id,
  destinationToken: destinationToken.value, recipientToken: recipientToken.value, substitution: substitution.value }) }
</script>

<template>
  <section class="panel" data-test="commerce-plan-panel">
    <header><div><h2>{{ t('commerce.plan.title') }}</h2><p>{{ t('commerce.plan.summary') }}</p></div>
      <select :value="selectedAccountId ?? ''" data-test="commerce-account-select" @change="emit('account', ($event.target as HTMLSelectElement).value)">
        <option v-for="item in accounts" :key="item.id" :value="item.id">{{ item.displayName }}</option>
      </select></header>
    <div class="search-row"><label>{{ t('commerce.plan.query') }}<input v-model="query" maxlength="200" data-test="commerce-query"></label>
      <label>{{ t('commerce.plan.quantity') }}<input v-model.number="quantity" type="number" min="1" max="9999"></label>
      <label>{{ t('commerce.plan.max') }}<input v-model.number="maxTotalMinor" type="number" min="0"></label></div>
    <div class="actions"><button :disabled="!canAct || !query.trim()" data-test="commerce-search" @click="search">{{ t('commerce.plan.search') }}</button>
      <button :disabled="!canAct || !offers.length || !query.trim()" data-test="commerce-compare" @click="compare">{{ t('commerce.plan.compare') }}</button></div>

    <div class="offers">
      <article v-for="offer in offers" :key="offer.id" :class="{ selected: offer.id === latestComparison?.selectedOfferSnapshotId }">
        <div><strong>{{ offer.title }}</strong><span>{{ offer.merchantName }}</span></div>
        <div><strong>{{ money(offer.money.amountMinor, offer.money.currency) }}</strong><span>{{ offer.fulfillmentMinutes ?? '—' }} min</span></div>
      </article>
      <p v-if="!offers.length" class="empty">{{ t('commerce.plan.noOffers') }}</p>
    </div>

    <div class="material" v-if="latestComparison">
      <p><strong>{{ t('commerce.plan.selected') }}</strong> {{ selectedOffer?.title ?? t('commerce.plan.noneEligible') }}</p>
      <p class="codes" v-if="latestComparison.candidates.find(item => item.offerSnapshotId === selectedOffer?.id)?.rationaleCodes.length">
        {{ latestComparison.candidates.find(item => item.offerSnapshotId === selectedOffer?.id)?.rationaleCodes.join(' · ') }}</p>
      <div class="token-grid"><label>{{ t('commerce.plan.destination') }}<input v-model="destinationToken" autocomplete="off" data-test="commerce-destination-token"></label>
        <label>{{ t('commerce.plan.recipient') }}<input v-model="recipientToken" autocomplete="off" data-test="commerce-recipient-token"></label>
        <label>{{ t('commerce.plan.substitution') }}<select v-model="substitution"><option value="deny">{{ t('commerce.plan.deny') }}</option><option value="same_sku_only">{{ t('commerce.plan.sameSku') }}</option></select></label></div>
      <div class="actions"><button :disabled="!canCreateCart" data-test="commerce-create-cart" @click="cart">{{ t('commerce.plan.cart') }}</button>
        <button :disabled="!canAct || !latestCart" data-test="commerce-create-quote" @click="emit('quote', latestCart!.id)">{{ t('commerce.plan.quote') }}</button>
        <button class="primary" :disabled="!canAct || !activeQuote" data-test="commerce-open-order-confirmation" @click="confirmQuote = activeQuote">{{ t('commerce.plan.order') }}</button></div>
    </div>

    <div v-if="confirmQuote" class="dialog-backdrop" data-test="commerce-order-confirmation">
      <section class="dialog" role="dialog" aria-modal="true"><h3>{{ t('commerce.confirm.title') }}</h3><p>{{ t('commerce.confirm.summary') }}</p>
        <dl><div><dt>{{ t('commerce.confirm.provider') }}</dt><dd>{{ account?.provider }}</dd></div>
          <div><dt>{{ t('commerce.confirm.merchant') }}</dt><dd>{{ selectedOffer?.merchantName }}</dd></div>
          <div><dt>{{ t('commerce.confirm.item') }}</dt><dd>{{ selectedOffer?.title }} × {{ quantity }}</dd></div>
          <div><dt>{{ t('commerce.confirm.destination') }}</dt><dd class="mono">{{ latestCart?.destinationDigest }}</dd></div>
          <div><dt>{{ t('commerce.confirm.substitution') }}</dt><dd>{{ latestCart?.substitution }}</dd></div>
          <div><dt>{{ t('commerce.confirm.expires') }}</dt><dd>{{ confirmQuote.expiresAt }}</dd></div>
          <div class="total"><dt>{{ t('commerce.confirm.total') }}</dt><dd>{{ money(confirmQuote.breakdown.totalMinor, confirmQuote.currency) }}</dd></div></dl>
        <p class="warning">{{ account?.mode === 'live' ? t('commerce.confirm.liveWarning') : t('commerce.confirm.shadowWarning') }}</p>
        <footer><button @click="confirmQuote = null">{{ t('commerce.common.cancel') }}</button><button class="primary" data-test="commerce-confirm-order" @click="emit('order', confirmQuote.id); confirmQuote = null">{{ t('commerce.confirm.submit') }}</button></footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.panel { padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color); }header,.actions,.offers article,.dialog footer { display:flex;align-items:center;justify-content:space-between;gap:10px }h2{margin:0}header p,.empty,.codes{color:var(--text-color-3)}header p{margin:4px 0 0}.search-row,.token-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:9px;margin:15px 0}label{font-size:12px;color:var(--text-color-2)}input,select{display:block;width:100%;box-sizing:border-box;margin-top:5px;padding:8px;border:1px solid var(--border-color);border-radius:7px;background:var(--input-color);color:var(--text-color)}button{padding:8px 12px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit;cursor:pointer}button:disabled{opacity:.45}.primary{background:var(--primary-color);color:#fff;border-color:transparent}.offers{margin:14px 0;max-height:270px;overflow:auto}.offers article{padding:10px 4px;border-top:1px solid var(--border-color)}.offers article.selected{color:var(--primary-color)}.offers span,.offers strong{display:block}.offers span{font-size:12px;color:var(--text-color-3)}.material{padding-top:10px;border-top:1px solid var(--border-color)}.token-grid{grid-template-columns:1fr 1fr 1fr}.dialog-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:#0008}.dialog{width:min(560px,100%);padding:20px;border-radius:12px;background:var(--card-color)}.dialog h3{margin-top:0}.dialog dl div{display:grid;grid-template-columns:130px 1fr;gap:10px;padding:7px 0;border-top:1px solid var(--border-color)}dt{color:var(--text-color-3)}dd{margin:0;overflow-wrap:anywhere}.total{font-size:18px}.mono{font:11px ui-monospace,monospace}.warning{padding:10px;border-radius:8px;background:color-mix(in srgb,var(--warning-color) 13%,transparent);color:var(--warning-color)}
@media(max-width:700px){.search-row,.token-grid{grid-template-columns:1fr}.actions{flex-wrap:wrap}}
</style>
