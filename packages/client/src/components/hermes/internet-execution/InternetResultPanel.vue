<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InternetEvidenceDto, InternetReceiptDto, InternetVideoDto } from '@/api/hermes/internet-execution'

const props = defineProps<{ receipts: InternetReceiptDto[]; selected: InternetReceiptDto | null; evidence: InternetEvidenceDto[] }>()
defineEmits<{ select: [receipt: InternetReceiptDto] }>()
const { t, locale } = useI18n()
const videos = computed<InternetVideoDto[]>(() => {
  const result = props.selected?.result
  if (!result) return []
  return result.operation === 'search' ? result.videos : [result.video]
})
const detail = computed(() => props.selected?.result?.operation === 'inspect' ? props.selected.result : null)
const formatter = computed(() => new Intl.NumberFormat(locale.value))
function duration(seconds: number | null): string {
  if (seconds === null) return '—'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
</script>

<template>
  <section class="panel result-panel" data-test="internet-result-panel">
    <header><div><h2>{{ t('internetExecution.result.title') }}</h2><p>{{ t('internetExecution.result.summary') }}</p></div>
      <span v-if="selected" class="receipt-status">{{ t(`internetExecution.receiptStatus.${selected.status}`) }}</span></header>
    <div v-if="selected" class="proof" data-test="internet-receipt-proof">
      <span>{{ t('internetExecution.result.executor') }} <strong>{{ selected.executorType === 'mcp' ? 'MCP' : t('internetExecution.status.browser') }}</strong></span>
      <span>{{ t('internetExecution.result.workflow') }} <strong>{{ selected.workflowId }}</strong></span>
      <span>{{ t('internetExecution.result.digest') }} <strong>{{ selected.resultDigest ? `${selected.resultDigest.slice(0, 12)}…` : '—' }}</strong></span>
      <span>{{ t('internetExecution.result.evidence') }} <strong>{{ evidence.length }}</strong></span>
    </div>
    <div v-if="videos.length" class="videos">
      <article v-for="video in videos" :key="video.bvid">
        <div><a :href="video.canonicalUrl" target="_blank" rel="noopener noreferrer">{{ video.title }}</a>
          <p>{{ video.author }} · {{ video.bvid }}</p></div>
        <dl><div><dt>{{ t('internetExecution.result.views') }}</dt><dd>{{ video.viewCount === null ? '—' : formatter.format(video.viewCount) }}</dd></div>
          <div><dt>{{ t('internetExecution.result.duration') }}</dt><dd>{{ duration(video.durationSeconds) }}</dd></div></dl>
      </article>
      <div v-if="detail" class="detail"><p>{{ detail.description || t('internetExecution.result.noDescription') }}</p>
        <span v-for="tag in detail.tags" :key="tag">#{{ tag }}</span></div>
    </div>
    <p v-else-if="selected" class="empty">{{ t('internetExecution.result.pending') }}</p>
    <p v-else class="empty">{{ t('internetExecution.result.empty') }}</p>
    <div class="history">
      <h3>{{ t('internetExecution.result.recent') }}</h3>
      <button v-for="receipt in receipts.slice(0, 8)" :key="receipt.workflowId" :class="{ active: receipt.workflowId === selected?.workflowId }"
        data-test="internet-receipt-row" @click="$emit('select', receipt)">
        <span>{{ receipt.operation === 'search' ? t('internetExecution.intent.search') : t('internetExecution.intent.inspect') }}</span>
        <small>{{ t(`internetExecution.receiptStatus.${receipt.status}`) }} · {{ receipt.executorType.toUpperCase() }}</small>
      </button>
      <p v-if="!receipts.length" class="empty">{{ t('internetExecution.result.noReceipts') }}</p>
    </div>
  </section>
</template>

<style scoped>
.panel { padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); } header { display: flex; justify-content: space-between; gap: 12px; } h2,h3 { margin: 0; } header p { margin: 5px 0 0; color: var(--text-color-2); }.receipt-status { align-self: start; padding: 4px 9px; border-radius: 999px; background: var(--action-color); }
.proof { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin: 14px 0; }.proof span { display: grid; gap: 2px; min-width: 0; color: var(--text-color-3); font-size: 11px; }.proof strong { overflow: hidden; color: var(--text-color); font-size: 12px; text-overflow: ellipsis; }
.videos { display: grid; gap: 8px; }.videos article { display: flex; justify-content: space-between; gap: 12px; padding: 11px; border-radius: 8px; background: var(--action-color); }.videos a { color: var(--primary-color); font-weight: 600; text-decoration: none; }.videos p { margin: 4px 0 0; color: var(--text-color-3); font-size: 12px; }.videos dl { display: flex; gap: 12px; margin: 0; }.videos dl div { text-align: right; }.videos dt { color: var(--text-color-3); font-size: 10px; }.videos dd { margin: 2px 0 0; white-space: nowrap; }
.detail { padding: 10px; }.detail p { margin: 0 0 6px; color: var(--text-color-2); }.detail span { margin-right: 7px; color: var(--primary-color); font-size: 12px; }.history { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-color); }.history h3 { margin-bottom: 8px; font-size: 14px; }.history button { display: flex; justify-content: space-between; width: 100%; padding: 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text-color); cursor: pointer; }.history button:hover,.history button.active { background: var(--action-color); }.history small,.empty { color: var(--text-color-3); }
@media (max-width: 700px) { .proof { grid-template-columns: 1fr 1fr; }.videos article { flex-direction: column; }.videos dl div { text-align: left; } }
</style>
