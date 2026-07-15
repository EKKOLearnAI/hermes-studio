<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LifeCancellationDto, LifeSubscriptionDto } from '@/api/hermes/life-orchestration'
import { lifeMoney, lifeTime, shortDigest } from './life-ui'
const props = defineProps<{ subscriptions: LifeSubscriptionDto[]; cancellations: LifeCancellationDto[]
  canWrite: boolean; busy: boolean }>()
const emit = defineEmits<{ cancel: [value: { subscriptionId: string; reasonCode: string }] }>()
const { t, locale } = useI18n()
const selectedId = ref(''); const reasonCode = ref('NO_LONGER_NEEDED'); const confirming = ref(false)
const selected = computed(() => props.subscriptions.find(item => item.id === selectedId.value) ?? null)
function open(item: LifeSubscriptionDto) { selectedId.value = item.id; reasonCode.value = 'NO_LONGER_NEEDED'; confirming.value = true }
function submit() { if (!selected.value) return; emit('cancel', { subscriptionId: selected.value.id, reasonCode: reasonCode.value }); confirming.value = false }
</script>
<template><section class="panel" data-test="life-subscriptions-panel"><h2>{{ t('life.subscriptions.title') }}</h2><p>{{ t('life.subscriptions.summary') }}</p>
  <div class="list"><article v-for="item in subscriptions" :key="item.id"><div><b>{{ item.serviceLabel }}</b><small>{{ item.planLabel }} · {{ item.state }}</small></div>
    <div><strong>{{ lifeMoney(item.recurringCost) }}</strong><small>{{ t('life.subscriptions.renews') }} {{ lifeTime(item.renewalAt, locale) }}</small></div>
    <button :disabled="busy || !canWrite || !['active','trial','paused'].includes(item.state)" :data-test="`life-cancel-${item.id}`" @click="open(item)">{{ t('life.subscriptions.cancel') }}</button></article>
    <p v-if="!subscriptions.length">{{ t('life.subscriptions.empty') }}</p></div>
  <div v-if="confirming && selected" class="confirm" data-test="life-subscription-confirmation"><h3>{{ t('life.subscriptions.confirmTitle') }}</h3>
    <dl><dt>{{ t('life.subscriptions.service') }}</dt><dd>{{ selected.serviceLabel }} · {{ selected.planLabel }}</dd>
      <dt>{{ t('life.subscriptions.cost') }}</dt><dd>{{ lifeMoney(selected.recurringCost) }}</dd>
      <dt>{{ t('life.subscriptions.deadline') }}</dt><dd>{{ selected.cancellationDeadline ? lifeTime(selected.cancellationDeadline, locale) : '—' }}</dd>
      <dt>{{ t('life.subscriptions.sourceDigest') }}</dt><dd>{{ shortDigest(selected.sourceDigest) }}</dd></dl>
    <label>{{ t('life.subscriptions.reason') }}<select v-model="reasonCode" data-test="life-cancellation-reason"><option value="NO_LONGER_NEEDED">NO_LONGER_NEEDED</option>
      <option value="TOO_EXPENSIVE">TOO_EXPENSIVE</option><option value="DUPLICATE_SERVICE">DUPLICATE_SERVICE</option></select></label>
    <p>{{ t('life.subscriptions.warning') }}</p><div><button @click="confirming = false">{{ t('life.common.back') }}</button>
      <button data-test="life-confirm-subscription-cancel" @click="submit">{{ t('life.subscriptions.confirm') }}</button></div></div>
  <details><summary>{{ t('life.subscriptions.history') }} ({{ cancellations.length }})</summary><ul><li v-for="item in cancellations" :key="item.id">{{ item.subscriptionId }} · {{ item.state }} · {{ item.reasonCode }}</li></ul></details>
</section></template>
<style scoped>.panel{padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color)}h2,h3{margin:0 0 5px}.panel>p,small{color:var(--text-color-3)}.list article{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--border-color)}.list article>div{display:grid}button,select{padding:7px 9px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit}.confirm{margin:12px 0;padding:14px;border:1px solid var(--warning-color);border-radius:9px}.confirm dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}.confirm dd{margin:0}.confirm label{display:grid;gap:5px}.confirm>div{display:flex;justify-content:flex-end;gap:8px}.confirm>p{color:var(--warning-color)}summary{cursor:pointer}ul{padding-left:20px;font-size:12px}@media(max-width:650px){.list article{grid-template-columns:1fr}.confirm dl{grid-template-columns:1fr}}</style>
