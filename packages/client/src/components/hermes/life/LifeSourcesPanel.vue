<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LifeActivationLimitsInput, LifeActivationReviewDto, LifeMode, LifeSourceDto,
  LifeSourceKind } from '@/api/hermes/life-orchestration'

const props = defineProps<{ sources: LifeSourceDto[]; selectedId: string | null; reviews: LifeActivationReviewDto[]
  canAdmin: boolean; canOperate: boolean; busy: boolean }>()
const emit = defineEmits<{
  select: [id: string]; sync: [id: string]; create: [value: { id: string; sourceKind: LifeSourceKind
    mode: 'observe' | 'shadow'; displayName: string }]
  health: [value: 'unknown' | 'healthy' | 'degraded' | 'unhealthy']; revoke: []
  activate: [value: { toMode: LifeMode; limits: LifeActivationLimitsInput }]
}>()
const { t } = useI18n()
const selected = computed(() => props.sources.find(item => item.id === props.selectedId) ?? null)
const sourceId = ref(''); const displayName = ref(''); const sourceKind = ref<LifeSourceKind>('calendar')
const createMode = ref<'observe' | 'shadow'>('observe'); const nextMode = ref<LifeMode>('shadow')
const currency = ref('CNY'); const subscriptionIds = ref(''); const confirming = ref(false)
watch(selected, value => { if (value) nextMode.value = value.mode === 'observe' ? 'shadow' : value.mode === 'shadow' ? 'live' : 'observe' })
const limits = computed<LifeActivationLimitsInput>(() => ({ currency: currency.value.trim().toUpperCase(),
  calendarIds: selected.value?.sourceKind === 'calendar' ? [selected.value.id] : [],
  subscriptionIds: selected.value?.sourceKind === 'subscriptions'
    ? subscriptionIds.value.split(',').map(item => item.trim()).filter(Boolean) : [] }))
const canActivate = computed(() => !!selected.value && props.canAdmin && !props.busy && nextMode.value !== selected.value.mode
  && (nextMode.value !== 'live' || selected.value.health === 'healthy' && (selected.value.sourceKind === 'calendar'
    || selected.value.sourceKind === 'subscriptions' && limits.value.subscriptionIds.length > 0)))
function create() { if (!sourceId.value.trim() || !displayName.value.trim()) return
  emit('create', { id: sourceId.value.trim(), sourceKind: sourceKind.value, mode: createMode.value,
    displayName: displayName.value.trim() }); sourceId.value = ''; displayName.value = '' }
function activate() { emit('activate', { toMode: nextMode.value, limits: limits.value }); confirming.value = false }
</script>

<template>
  <section class="panel" data-test="life-sources-panel"><header><div><h2>{{ t('life.sources.title') }}</h2>
    <p>{{ t('life.sources.summary') }}</p></div></header>
    <div class="source-list"><button v-for="item in sources" :key="item.id" :class="{ active: item.id === selectedId }"
      @click="$emit('select', item.id)"><span><b>{{ item.displayName }}</b><small>{{ item.sourceKind }}</small></span>
      <span class="badges"><i>{{ t(`life.mode.${item.mode}`) }}</i><i>{{ t(`life.health.${item.health}`) }}</i></span></button>
      <p v-if="!sources.length" class="muted">{{ t('life.sources.empty') }}</p></div>
    <div v-if="selected" class="actions"><button :disabled="busy || !canOperate || selected.health === 'revoked'" data-test="life-sync-source"
      @click="$emit('sync', selected.id)">{{ t('life.sources.sync') }}</button>
      <select :disabled="!canAdmin || busy" @change="$emit('health', ($event.target as HTMLSelectElement).value as any)">
        <option value="">{{ t('life.sources.health') }}</option><option value="healthy">{{ t('life.health.healthy') }}</option>
        <option value="degraded">{{ t('life.health.degraded') }}</option><option value="unhealthy">{{ t('life.health.unhealthy') }}</option></select>
      <select v-model="nextMode" :disabled="!canAdmin || busy"><option value="observe">{{ t('life.mode.observe') }}</option>
        <option value="shadow">{{ t('life.mode.shadow') }}</option><option value="live">{{ t('life.mode.live') }}</option></select>
      <input v-model="currency" maxlength="3" :aria-label="t('life.sources.currency')" />
      <input v-if="selected.sourceKind === 'subscriptions'" v-model="subscriptionIds" data-test="life-subscription-targets"
        :placeholder="t('life.sources.subscriptionIds')" />
      <button :disabled="!canActivate" data-test="life-open-activation" @click="confirming = true">{{ t('life.sources.activate') }}</button>
      <button class="danger" :disabled="!canAdmin || busy || selected.health === 'revoked'" @click="$emit('revoke')">{{ t('life.sources.revoke') }}</button></div>
    <div v-if="confirming && selected" class="confirm" data-test="life-activation-confirmation"><h3>{{ t('life.sources.confirmTitle') }}</h3>
      <p>{{ selected.displayName }} · {{ selected.mode }} → {{ nextMode }}</p><p>{{ t('life.sources.exactTargets') }}:
        {{ [...limits.calendarIds, ...limits.subscriptionIds].join(', ') || '—' }}</p><p>{{ t('life.sources.activationWarning') }}</p>
      <div><button @click="confirming = false">{{ t('life.common.back') }}</button><button data-test="life-confirm-activation"
        @click="activate">{{ t('life.sources.confirm') }}</button></div></div>
    <details v-if="canAdmin"><summary>{{ t('life.sources.add') }}</summary><div class="create-grid">
      <input v-model="sourceId" data-test="life-source-id" :placeholder="t('life.sources.id')" />
      <input v-model="displayName" data-test="life-source-name" :placeholder="t('life.sources.name')" />
      <select v-model="sourceKind"><option v-for="kind in ['calendar','contacts','travel','music','games','subscriptions']" :key="kind" :value="kind">{{ kind }}</option></select>
      <select v-model="createMode"><option value="observe">{{ t('life.mode.observe') }}</option><option value="shadow">{{ t('life.mode.shadow') }}</option></select>
      <button :disabled="busy || !sourceId.trim() || !displayName.trim()" data-test="life-create-source" @click="create">{{ t('life.sources.add') }}</button></div></details>
    <p class="boundary">{{ t('life.sources.boundary') }}</p>
    <ul v-if="reviews.length"><li v-for="review in reviews.slice(0,4)" :key="review.id">{{ review.fromMode }} → {{ review.toMode }} ·
      {{ review.approved ? t('life.sources.approved') : t('life.sources.denied') }}</li></ul>
  </section>
</template>

<style scoped>
.panel{padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color)}h2,h3{margin:0 0 5px}p{margin:4px 0 12px;color:var(--text-color-3)}.source-list button{width:100%;display:flex;justify-content:space-between;align-items:center;padding:10px;border:0;border-top:1px solid var(--border-color);background:transparent;color:inherit;text-align:left}.source-list button.active{background:var(--action-color)}.source-list span:first-child{display:grid}.badges{display:flex;gap:5px}.badges i{font-style:normal;font-size:11px;padding:3px 6px;border-radius:10px;background:var(--tag-color)}small,.muted{color:var(--text-color-3)}.actions,.create-grid{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.actions input,.actions select,.actions button,.create-grid input,.create-grid select,.create-grid button,.confirm button{padding:7px 9px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit}.danger{color:var(--error-color)!important}.confirm{margin-top:12px;padding:14px;border:1px solid var(--warning-color);border-radius:9px}.confirm div{display:flex;justify-content:flex-end;gap:8px}.boundary{padding:9px;border-radius:7px;background:var(--action-color)}summary{cursor:pointer}ul{padding-left:20px;font-size:12px}
</style>
