<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { LifeCalendarHoldDto, LifeCommitmentDto, LifeOverviewDto, LifePlanDto } from '@/api/hermes/life-orchestration'
import { lifeMoney, lifeTime } from './life-ui'

defineProps<{ overview: LifeOverviewDto | null; commitments: LifeCommitmentDto[]; plans: LifePlanDto[]
  holds: LifeCalendarHoldDto[] }>()
defineEmits<{ plan: [id: string] }>()
const { t, locale } = useI18n()
</script>

<template>
  <section class="panel" data-test="life-today-panel">
    <header><div><span>{{ t('life.today.kicker') }}</span><h2>{{ t('life.today.title') }}</h2></div>
      <strong :class="{ stopped: overview?.runtime.emergencyStopped }">{{ overview?.runtime.emergencyStopped
        ? t('life.today.stopped') : t('life.today.ready') }}</strong></header>
    <div class="metrics">
      <article><b>{{ overview?.summary.accountCount ?? 0 }}</b><small>{{ t('life.today.sources') }}</small></article>
      <article><b>{{ overview?.summary.activePlanCount ?? 0 }}</b><small>{{ t('life.today.plans') }}</small></article>
      <article><b>{{ commitments.length }}</b><small>{{ t('life.today.commitments') }}</small></article>
      <article><b>{{ overview?.summary.pendingTakeoverCount ?? 0 }}</b><small>{{ t('life.today.takeovers') }}</small></article>
    </div>
    <div class="columns">
      <div><h3>{{ t('life.today.schedule') }}</h3><p v-if="!commitments.length" class="muted">{{ t('life.today.emptySchedule') }}</p>
        <button v-for="item in commitments.slice(0, 8)" :key="item.id" class="row static">
          <span><b>{{ item.label }}</b><small>{{ item.category }} · {{ item.locationClass }}</small></span>
          <time>{{ lifeTime(item.startsAt, locale) }}</time></button></div>
      <div><h3>{{ t('life.today.activePlans') }}</h3><p v-if="!plans.length" class="muted">{{ t('life.today.emptyPlans') }}</p>
        <button v-for="item in plans.slice(0, 6)" :key="item.id" class="row" @click="$emit('plan', item.id)">
          <span><b>{{ item.sessions.length }} {{ t('life.today.sessions') }}</b><small>{{ item.state }}</small></span>
          <strong>{{ lifeMoney(item.totalCost) }}</strong></button>
        <p class="muted">{{ t('life.today.holds') }}: {{ holds.filter(item => !['cancelled', 'failed'].includes(item.state)).length }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel{padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color)}header{display:flex;justify-content:space-between;gap:12px}header span,.muted,small{color:var(--text-color-3)}h2,h3{margin:3px 0 10px}.stopped{color:var(--error-color)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:14px 0}.metrics article{padding:12px;border-radius:9px;background:var(--action-color);display:grid}.metrics b{font-size:20px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}.row{width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;gap:12px;padding:9px 0;border:0;border-top:1px solid var(--border-color);background:transparent;color:inherit;cursor:pointer}.row span{display:grid}.row time{font-size:12px;color:var(--text-color-3)}.static{cursor:default}@media(max-width:760px){.metrics{grid-template-columns:1fr 1fr}.columns{grid-template-columns:1fr}}
</style>
