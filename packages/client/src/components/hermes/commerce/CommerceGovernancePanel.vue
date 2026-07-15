<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CommerceAccountDto, CommerceActivationLimitsInput, CommerceActivationReviewDto,
  CommerceMode, CommerceTakeoverDto, CommerceWorkflowDto } from '@/api/hermes/commerce'

const props = defineProps<{ account: CommerceAccountDto | null; reviews: CommerceActivationReviewDto[]
  workflows: CommerceWorkflowDto[]; takeovers: CommerceTakeoverDto[]; canWrite: boolean; busy: boolean }>()
const emit = defineEmits<{ activate: [value: { toMode: CommerceMode; limits: CommerceActivationLimitsInput }]
  health: [value: Exclude<CommerceAccountDto['health'], 'revoked'>]; revoke: []
  selectWorkflow: [id: string]; reviewWorkflow: [value: { id: string; action: 'approve' | 'reject'; reason: string }] }>()
const { t } = useI18n()
const toMode = ref<CommerceMode>('shadow')
const perActionMinor = ref(5000)
const dailyMinor = ref(10000)
const merchantIds = ref('')
const destinationDigests = ref('')
const reviewReason = ref('USER_REJECTED')
const confirmActivation = ref(false)
watch(() => props.account?.currency, () => { confirmActivation.value = false })
const parsedLimits = computed<CommerceActivationLimitsInput>(() => ({ currency: props.account?.currency ?? 'CNY',
  perActionMinor: perActionMinor.value, dailyMinor: dailyMinor.value,
  merchantIds: split(merchantIds.value), destinationDigests: split(destinationDigests.value) }))
const validActivation = computed(() => !!props.account && props.canWrite && !props.busy
  && perActionMinor.value >= 0 && dailyMinor.value >= perActionMinor.value
  && parsedLimits.value.merchantIds.every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
  && parsedLimits.value.destinationDigests.every(value => /^[a-f0-9]{64}$/.test(value))
  && (toMode.value !== 'live' || parsedLimits.value.destinationDigests.length > 0))
function split(value: string) { return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))].sort() }
</script>

<template>
  <section class="panel" data-test="commerce-governance-panel">
    <header><div><h2>{{ t('commerce.governance.title') }}</h2><p>{{ t('commerce.governance.summary') }}</p></div></header>
    <div v-if="account" class="activation">
      <div class="gate"><strong>{{ account.displayName }}</strong><span>{{ t(`commerce.mode.${account.mode}`) }} · {{ t(`commerce.health.${account.health}`) }} · epoch {{ account.policyEpoch }}</span></div>
      <div class="form"><label>{{ t('commerce.governance.nextMode') }}<select v-model="toMode"><option value="observe">{{ t('commerce.mode.observe') }}</option><option value="shadow">{{ t('commerce.mode.shadow') }}</option><option value="live">{{ t('commerce.mode.live') }}</option></select></label>
        <label>{{ t('commerce.governance.perAction') }}<input v-model.number="perActionMinor" type="number" min="0"></label>
        <label>{{ t('commerce.governance.daily') }}<input v-model.number="dailyMinor" type="number" min="0"></label>
        <label>{{ t('commerce.governance.merchants') }}<input v-model="merchantIds" placeholder="merchant-1,merchant-2"></label>
        <label>{{ t('commerce.governance.destinations') }}<input v-model="destinationDigests" placeholder="64-char digest"></label></div>
      <div class="actions"><button :disabled="!validActivation" data-test="commerce-open-activation" @click="confirmActivation = true">{{ t('commerce.governance.activate') }}</button>
        <button :disabled="!canWrite || busy || account.health === 'revoked'" @click="emit('health','healthy')">{{ t('commerce.governance.markHealthy') }}</button>
        <button class="danger" :disabled="!canWrite || busy || account.health === 'revoked'" data-test="commerce-revoke-account" @click="emit('revoke')">{{ t('commerce.governance.revoke') }}</button></div>
      <p class="boundary">{{ t('commerce.governance.boundary') }}</p>
      <div class="reviews"><span v-for="review in reviews.slice(0,3)" :key="review.id" :class="{ denied: !review.approved }">{{ review.fromMode }}→{{ review.toMode }} · {{ review.approved ? t('commerce.governance.approved') : t('commerce.governance.denied') }}</span></div>
    </div>
    <div class="workflow-grid"><div><h3>{{ t('commerce.governance.workflows') }}</h3>
      <button v-for="workflow in workflows.slice(0,12)" :key="workflow.id" class="workflow" :data-test="`commerce-workflow-${workflow.id}`" @click="emit('selectWorkflow', workflow.id)"><span>{{ workflow.capabilityId }}</span><strong>{{ t(`commerce.workflowState.${workflow.state}`) }}</strong>
        <i v-if="workflow.availableActions.approve" @click.stop="emit('reviewWorkflow',{id:workflow.id,action:'approve',reason:''})">{{ t('commerce.governance.approve') }}</i>
        <i v-if="workflow.availableActions.reject" @click.stop="emit('reviewWorkflow',{id:workflow.id,action:'reject',reason:reviewReason})">{{ t('commerce.governance.reject') }}</i></button>
      <p v-if="!workflows.length" class="empty">{{ t('commerce.governance.noWorkflows') }}</p></div>
      <div><h3>{{ t('commerce.governance.takeovers') }}</h3><article v-for="item in takeovers" :key="item.workflowId"><strong>{{ item.reasonCode }}</strong><span>{{ item.capabilityId }}</span><small>{{ t('commerce.governance.takeoverPrivacy') }}</small></article>
        <p v-if="!takeovers.length" class="empty">{{ t('commerce.governance.noTakeovers') }}</p></div></div>
    <div v-if="confirmActivation" class="dialog-backdrop" data-test="commerce-activation-confirmation"><section class="dialog" role="dialog" aria-modal="true"><h3>{{ t('commerce.governance.confirmTitle') }}</h3>
      <p>{{ t('commerce.governance.confirmSummary') }}</p><dl><div><dt>{{ t('commerce.governance.nextMode') }}</dt><dd>{{ toMode }}</dd></div><div><dt>{{ t('commerce.governance.perAction') }}</dt><dd>{{ parsedLimits.currency }} {{ (perActionMinor/100).toFixed(2) }}</dd></div><div><dt>{{ t('commerce.governance.daily') }}</dt><dd>{{ parsedLimits.currency }} {{ (dailyMinor/100).toFixed(2) }}</dd></div><div><dt>{{ t('commerce.governance.destinations') }}</dt><dd>{{ parsedLimits.destinationDigests.length }}</dd></div></dl>
      <footer><button @click="confirmActivation=false">{{ t('commerce.common.cancel') }}</button><button class="primary" data-test="commerce-confirm-activation" @click="emit('activate',{toMode,limits:parsedLimits});confirmActivation=false">{{ t('commerce.governance.confirm') }}</button></footer></section></div>
  </section>
</template>

<style scoped>
.panel{padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color)}h2{margin:0}header p,.empty,.boundary{color:var(--text-color-3)}header p{margin:4px 0 14px}.activation{padding:12px;border-radius:9px;background:var(--hover-color)}.gate{display:flex;justify-content:space-between}.gate span{color:var(--text-color-3)}.form{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.form label{font-size:11px;color:var(--text-color-3)}input,select{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:7px;border:1px solid var(--border-color);border-radius:7px;background:var(--input-color);color:inherit}.actions{display:flex;gap:8px;flex-wrap:wrap}button{padding:7px 10px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit;cursor:pointer}button:disabled{opacity:.45}.danger{color:var(--error-color)}.primary{background:var(--primary-color);color:#fff;border-color:transparent}.reviews{display:flex;gap:6px;flex-wrap:wrap}.reviews span{padding:3px 6px;border-radius:99px;background:color-mix(in srgb,var(--success-color) 12%,transparent);font-size:10px}.reviews .denied{background:color-mix(in srgb,var(--error-color) 12%,transparent)}.workflow-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.workflow{display:grid;width:100%;grid-template-columns:1fr auto auto auto;gap:7px;text-align:left;border-width:0 0 1px}.workflow span{overflow:hidden;text-overflow:ellipsis}.workflow i{color:var(--primary-color);font-style:normal}article{padding:8px;border-bottom:1px solid var(--border-color)}article strong,article span,article small{display:block}article span,article small{color:var(--text-color-3);font-size:11px}.dialog-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:#0008}.dialog{width:min(480px,100%);padding:20px;border-radius:12px;background:var(--card-color)}.dialog h3{margin-top:0}.dialog dl div{display:grid;grid-template-columns:140px 1fr;padding:7px 0;border-top:1px solid var(--border-color)}dd{margin:0;overflow-wrap:anywhere}footer{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:800px){.form,.workflow-grid{grid-template-columns:1fr}.gate{display:block}}
</style>
