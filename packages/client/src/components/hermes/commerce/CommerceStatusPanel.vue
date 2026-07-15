<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { CommerceOverviewDto } from '@/api/hermes/commerce'

defineProps<{ overview: CommerceOverviewDto | null }>()
const emit = defineEmits<{ account: [id: string] }>()
const { t } = useI18n()
</script>

<template>
  <section class="panel" data-test="commerce-status-panel">
    <header><div><span class="kicker">{{ t('commerce.status.kicker') }}</span><h2>{{ t('commerce.status.title') }}</h2></div>
      <span class="runtime" :class="{ ready: overview?.runtime.configuredAccountCount }">
        {{ overview?.runtime.emergencyStopped ? t('commerce.status.stopped') : overview?.runtime.configuredAccountCount ? t('commerce.status.ready') : t('commerce.status.unavailable') }}
      </span></header>
    <div class="metrics">
      <div><strong>{{ overview?.summary.accountCount ?? 0 }}</strong><span>{{ t('commerce.status.accounts') }}</span></div>
      <div><strong>{{ overview?.summary.liveAccountCount ?? 0 }}</strong><span>{{ t('commerce.status.live') }}</span></div>
      <div><strong>{{ overview?.summary.activeOfferCount ?? 0 }}</strong><span>{{ t('commerce.status.offers') }}</span></div>
      <div><strong>{{ overview?.summary.activeTransactionCount ?? 0 }}</strong><span>{{ t('commerce.status.transactions') }}</span></div>
      <div><strong>{{ overview?.summary.pendingTakeoverCount ?? 0 }}</strong><span>{{ t('commerce.status.takeovers') }}</span></div>
    </div>
    <div class="accounts">
      <button v-for="account in overview?.accounts ?? []" :key="account.id" type="button"
        :data-test="`commerce-account-${account.id}`" @click="emit('account', account.id)">
        <span><strong>{{ account.displayName }}</strong><small>{{ account.provider }} · {{ account.currency }}</small></span>
        <span class="badges"><i :class="account.mode">{{ t(`commerce.mode.${account.mode}`) }}</i><i :class="account.health">{{ t(`commerce.health.${account.health}`) }}</i></span>
      </button>
      <p v-if="!overview?.accounts.length" class="empty">{{ t('commerce.status.noAccounts') }}</p>
    </div>
  </section>
</template>

<style scoped>
.panel { padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); }
header,.accounts button,.badges { display: flex; align-items: center; justify-content: space-between; gap: 12px; }h2 { margin: 2px 0 0; }.kicker { color: var(--primary-color); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }.runtime { color: var(--error-color); }.runtime.ready { color: var(--success-color); }
.metrics { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 8px; margin: 16px 0; }.metrics div { padding: 11px; border-radius: 9px; background: var(--hover-color); }.metrics strong,.metrics span,.accounts strong,.accounts small { display: block; }.metrics strong { font-size: 21px; }.metrics span,.accounts small { color: var(--text-color-3); font-size: 12px; }
.accounts { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }.accounts button { padding: 11px; border: 1px solid var(--border-color); border-radius: 9px; background: transparent; color: inherit; text-align: left; cursor: pointer; }.badges i { padding: 3px 7px; border-radius: 99px; background: var(--hover-color); font-size: 11px; font-style: normal; }.badges .live { color: var(--error-color); }.badges .shadow { color: var(--warning-color); }.badges .healthy { color: var(--success-color); }.badges .revoked,.badges .unhealthy { color: var(--error-color); }.empty { color: var(--text-color-3); }
@media(max-width:800px){.metrics { grid-template-columns: repeat(2,1fr); }.accounts { grid-template-columns: 1fr; }}
</style>
