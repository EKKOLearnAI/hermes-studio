<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CreateLifeConstraintInput, LifeConstraintDto, LifeOptionDto, LifePlanDto, LifeSourceDto } from '@/api/hermes/life-orchestration'
import { lifeMoney, lifeTime, shortDigest } from './life-ui'

const props = defineProps<{ constraints: LifeConstraintDto[]; plans: LifePlanDto[]; selectedPlanId: string | null
  options: LifeOptionDto[]; sources: LifeSourceDto[]; materialChanged: boolean; canWrite: boolean; busy: boolean }>()
const emit = defineEmits<{
  select: [id: string]; constraint: [value: CreateLifeConstraintInput]; plan: [constraintId: string]
  verify: [planId: string]; hold: [value: { accountId: string; planRevisionId: string; optionId: string }]
}>()
const { t, locale } = useI18n()
const selected = computed(() => props.plans.find(item => item.id === props.selectedPlanId) ?? props.plans[0] ?? null)
const calendarSources = computed(() => props.sources.filter(item => item.sourceKind === 'calendar'
  && item.enabled && !['revoked', 'unhealthy'].includes(item.health)))
const calendarId = ref(''); const sessionOptionId = ref(''); const confirming = ref(false)
const currency = ref('CNY'); const budgetMinor = ref(10000); const screenMinutes = ref(120)
const leisureMinutes = ref(180); const travelKm = ref(30); const preferences = ref('music,video,game')
const session = computed(() => selected.value?.sessions.find(item => item.optionId === sessionOptionId.value) ?? null)
function createConstraint() {
  const createdAt = new Date().toISOString(); const expiresAt = new Date(Date.parse(createdAt) + 24 * 60 * 60_000).toISOString()
  emit('constraint', { horizon: { startsAt: createdAt, endsAt: expiresAt }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    policy: { budget: { currency: currency.value.trim().toUpperCase(), amountMinor: budgetMinor.value },
      screenTimeLimitMinutes: screenMinutes.value, leisureTimeLimitMinutes: leisureMinutes.value,
      quietStartMinute: 1320, quietEndMinute: 420, maxTravelRadiusKm: travelKm.value, excludedCategories: [],
      preferredCategories: preferences.value.split(',').map(item => item.trim()).filter(Boolean) },
    createdAt, expiresAt, useTwinPreferences: true })
}
function openHold() { if (!selected.value || !session.value || !calendarId.value || props.materialChanged) return; confirming.value = true }
function submitHold() { if (!selected.value || !session.value) return
  emit('hold', { accountId: calendarId.value, planRevisionId: selected.value.id, optionId: session.value.optionId }); confirming.value = false }
</script>

<template>
  <section class="panel" data-test="life-planner-panel"><header><div><h2>{{ t('life.planner.title') }}</h2><p>{{ t('life.planner.summary') }}</p></div>
    <button :disabled="busy || !canWrite" data-test="life-create-constraint" @click="createConstraint">{{ t('life.planner.freeze') }}</button></header>
    <div class="policy"><label>{{ t('life.planner.currency') }}<input v-model="currency" maxlength="3" /></label>
      <label>{{ t('life.planner.budget') }}<input v-model.number="budgetMinor" type="number" min="0" /></label>
      <label>{{ t('life.planner.screen') }}<input v-model.number="screenMinutes" type="number" min="0" /></label>
      <label>{{ t('life.planner.leisure') }}<input v-model.number="leisureMinutes" type="number" min="0" /></label>
      <label>{{ t('life.planner.radius') }}<input v-model.number="travelKm" type="number" min="0" /></label>
      <label>{{ t('life.planner.preferences') }}<input v-model="preferences" /></label></div>
    <div class="toolbar"><select :value="selected?.id ?? ''" data-test="life-plan-select" @change="$emit('select', ($event.target as HTMLSelectElement).value)">
      <option value="">{{ t('life.planner.noPlan') }}</option><option v-for="plan in plans" :key="plan.id" :value="plan.id">{{ plan.id }} · {{ plan.state }}</option></select>
      <button :disabled="busy || !canWrite || !constraints[0]" data-test="life-create-plan" @click="$emit('plan', constraints[0]!.id)">{{ t('life.planner.generate') }}</button>
      <button :disabled="busy || !canWrite || !selected" data-test="life-verify-plan" @click="selected && $emit('verify', selected.id)">{{ t('life.planner.verify') }}</button></div>
    <p v-if="materialChanged" class="warning" data-test="life-material-change">{{ t('life.planner.materialChanged') }}</p>
    <div v-if="selected" class="plan"><div class="digest"><span>{{ t('life.planner.planDigest') }} {{ shortDigest(selected.planDigest) }}</span>
      <span>{{ t('life.planner.constraintDigest') }} {{ shortDigest(selected.constraintDigest) }}</span></div>
      <div class="summary"><strong>{{ selected.totalMinutes }} {{ t('life.planner.minutes') }}</strong><strong>{{ lifeMoney(selected.totalCost) }}</strong>
        <span>{{ selected.sessions.length }} {{ t('life.planner.sessions') }}</span></div>
      <label>{{ t('life.planner.session') }}<select v-model="sessionOptionId" data-test="life-hold-session"><option value="">—</option>
        <option v-for="item in selected.sessions" :key="`${item.optionId}:${item.startsAt}`" :value="item.optionId">{{ options.find(option => option.id === item.optionId)?.title ?? item.optionId }} · {{ lifeTime(item.startsAt, locale) }}</option></select></label>
      <label>{{ t('life.planner.calendar') }}<select v-model="calendarId" data-test="life-hold-calendar"><option value="">—</option>
        <option v-for="source in calendarSources" :key="source.id" :value="source.id">{{ source.displayName }} · {{ source.mode }}</option></select></label>
      <button :disabled="busy || !canWrite || !session || !calendarId || materialChanged" data-test="life-open-hold-confirmation" @click="openHold">{{ t('life.planner.hold') }}</button></div>
    <p v-else class="empty">{{ t('life.planner.empty') }}</p>
    <div v-if="confirming && selected && session" class="confirm" data-test="life-hold-confirmation"><h3>{{ t('life.planner.confirmTitle') }}</h3>
      <dl><dt>{{ t('life.planner.option') }}</dt><dd>{{ options.find(item => item.id === session!.optionId)?.title ?? session.optionId }}</dd>
        <dt>{{ t('life.planner.window') }}</dt><dd>{{ lifeTime(session.startsAt, locale) }} → {{ lifeTime(session.endsAt, locale) }}</dd>
        <dt>{{ t('life.planner.cost') }}</dt><dd>{{ lifeMoney(session.cost) }}</dd><dt>{{ t('life.planner.planDigest') }}</dt><dd>{{ selected.planDigest }}</dd>
        <dt>{{ t('life.planner.calendar') }}</dt><dd>{{ calendarId }}</dd></dl><p>{{ t('life.planner.holdWarning') }}</p>
      <div><button @click="confirming = false">{{ t('life.common.back') }}</button><button data-test="life-confirm-hold" @click="submitHold">{{ t('life.planner.confirmHold') }}</button></div></div>
  </section>
</template>

<style scoped>
.panel{padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color)}header,.toolbar,.summary,.digest,.confirm>div{display:flex;justify-content:space-between;gap:9px;flex-wrap:wrap}h2,h3{margin:0 0 5px}p{margin:4px 0 12px;color:var(--text-color-3)}button,select,input{padding:7px 9px;border:1px solid var(--border-color);border-radius:7px;background:transparent;color:inherit}.policy{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.policy label,.plan label{display:grid;gap:4px;font-size:12px}.toolbar{justify-content:flex-start}.plan{margin-top:13px;padding:13px;border-radius:9px;background:var(--action-color)}.digest{font:11px monospace;color:var(--text-color-3)}.summary{margin:12px 0}.warning{padding:10px;background:color-mix(in srgb,var(--warning-color) 14%,transparent);color:var(--warning-color)}.confirm{margin-top:12px;padding:14px;border:1px solid var(--warning-color);border-radius:9px}.confirm dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}.confirm dd{margin:0;overflow-wrap:anywhere}.empty{padding:14px;text-align:center}@media(max-width:720px){.policy{grid-template-columns:1fr 1fr}}
</style>
