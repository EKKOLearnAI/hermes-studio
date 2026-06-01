<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getQuantLabPostMortems, type QuantLabPostMortemReport } from '@/api/hermes/quant-lab'
import { useTerminalState } from '@/composables/useTerminalState'

const reports = ref<QuantLabPostMortemReport[]>([])
const selectedId = ref<string>('')
const loading = ref(false)
const error = ref('')
const { activeTicker, setActiveTicker } = useTerminalState()

async function fetchPostMortems(): Promise<QuantLabPostMortemReport[]> {
  const response = await getQuantLabPostMortems(80)
  return response.entries || []
}

async function loadPostMortems() {
  loading.value = true
  error.value = ''
  try {
    reports.value = await fetchPostMortems()
    selectedId.value = reports.value[0]?.id || ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : '讀取記憶庫失敗'
  } finally {
    loading.value = false
  }
}

const selectedReport = computed(() => reports.value.find(report => report.id === selectedId.value) || reports.value[0] || null)
const winCount = computed(() => reports.value.filter(report => report.result === 'Win').length)
const lossCount = computed(() => reports.value.filter(report => report.result === 'Loss').length)

function selectReport(report: QuantLabPostMortemReport) {
  selectedId.value = report.id
  setActiveTicker(report.ticker)
}

function resultClass(result: QuantLabPostMortemReport['result']) {
  if (result === 'Win') return 'is-win'
  if (result === 'Loss') return 'is-loss'
  if (result === 'Flat') return 'is-flat'
  return 'is-unknown'
}

function displayResult(result: QuantLabPostMortemReport['result']) {
  if (result === 'Win') return '獲利'
  if (result === 'Loss') return '虧損'
  if (result === 'Flat') return '持平'
  return '未知'
}

function formatPnl(value: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatScoreDelta(value: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}`
}

function formatDate(value: string) {
  if (!value) return '未知時間'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function scoreTone(value: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'neutral'
  if (value > 0) return 'positive'
  if (value < 0) return 'negative'
  return 'neutral'
}

onMounted(loadPostMortems)
</script>

<template>
  <section class="memory-vault-panel">
    <header class="memory-header">
      <div>
        <span>OpenClaw / Obsidian 記憶庫</span>
        <strong>{{ reports.length }} 份檢討</strong>
      </div>
      <div class="memory-stats">
        <span class="positive">勝 {{ winCount }}</span>
        <span class="negative">敗 {{ lossCount }}</span>
        <button type="button" :disabled="loading" @click="loadPostMortems">
          {{ loading ? '讀取中' : '刷新' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="memory-error">{{ error }}</div>

    <div v-if="!loading && !reports.length && !error" class="memory-empty">
      <strong>尚無事後檢討報告</strong>
      <span>紙上交易完成平倉後，AgentEvaluator 會把 Post-Mortem 寫入 Obsidian，這裡會自動顯示。</span>
    </div>

    <div v-else class="memory-grid">
      <aside class="memory-list" aria-label="事後檢討報告清單">
        <button
          v-for="report in reports"
          :key="report.id"
          type="button"
          class="memory-row"
          :class="{ active: selectedReport?.id === report.id, focused: activeTicker === report.ticker }"
          @click="selectReport(report)"
        >
          <span class="ticker">{{ report.ticker }}</span>
          <span class="date">{{ formatDate(report.date) }}</span>
          <span class="result" :class="resultClass(report.result)">{{ displayResult(report.result) }}</span>
          <strong :class="resultClass(report.result)">{{ formatPnl(report.pnlPct) }}</strong>
        </button>
      </aside>

      <article v-if="selectedReport" class="memory-detail">
        <div class="detail-topline">
          <div>
            <span>檢討報告</span>
            <strong>{{ selectedReport.ticker }}</strong>
          </div>
          <div class="detail-result" :class="resultClass(selectedReport.result)">
            {{ displayResult(selectedReport.result) }} {{ formatPnl(selectedReport.pnlPct) }}
          </div>
        </div>

        <div class="score-strip">
          <div :class="scoreTone(selectedReport.agentScores.quant)">
            <span>量化</span>
            <strong>{{ formatScoreDelta(selectedReport.agentScores.quant) }}</strong>
          </div>
          <div :class="scoreTone(selectedReport.agentScores.bull)">
            <span>多方 Agent</span>
            <strong>{{ formatScoreDelta(selectedReport.agentScores.bull) }}</strong>
          </div>
          <div :class="scoreTone(selectedReport.agentScores.bear)">
            <span>空方 Agent</span>
            <strong>{{ formatScoreDelta(selectedReport.agentScores.bear) }}</strong>
          </div>
          <div>
            <span>VIX</span>
            <strong>{{ selectedReport.vix ?? 'n/a' }}</strong>
          </div>
        </div>

        <section class="insight-box">
          <span>可執行教訓</span>
          <p>{{ selectedReport.actionableInsight || '此報告尚未產生 Actionable Insight。' }}</p>
        </section>

        <pre class="markdown-body">{{ selectedReport.markdown }}</pre>
      </article>
    </div>
  </section>
</template>

<style scoped>
.memory-vault-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto 1fr;
  background: #050505;
  color: #d8eef3;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
}

.memory-header,
.detail-topline,
.score-strip,
.insight-box,
.memory-row {
  border: 1px solid #20272d;
}

.memory-header {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  background: #070707;
}

.memory-header span,
.detail-topline span,
.score-strip span,
.insight-box span,
.date {
  color: #73818f;
  font-size: 10px;
  text-transform: uppercase;
}

.memory-header strong,
.detail-topline strong {
  margin-left: 8px;
  color: #eafcff;
}

.memory-stats {
  display: flex;
  align-items: center;
  gap: 10px;
}

.memory-stats button {
  height: 22px;
  padding: 0 12px;
  border: 1px solid #164b2c;
  background: #07100b;
  color: #00ff88;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.memory-stats button:disabled {
  opacity: 0.5;
  cursor: wait;
}

.memory-error,
.memory-empty {
  margin: 10px;
  border: 1px solid #6a1730;
  color: #ff365e;
  background: rgba(255, 54, 94, 0.06);
  padding: 10px;
}

.memory-empty {
  display: grid;
  gap: 8px;
  color: #ffd700;
  border-color: #4a3a00;
  background: rgba(255, 215, 0, 0.04);
}

.memory-grid {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(240px, 28%) 1fr;
  border-top: 1px solid #111820;
}

.memory-list,
.memory-detail {
  min-height: 0;
  overflow: auto;
}

.memory-list {
  border-right: 1px solid #20272d;
  background:
    linear-gradient(rgba(0, 229, 255, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.035) 1px, transparent 1px),
    #050505;
  background-size: 42px 42px;
}

.memory-row {
  width: 100%;
  display: grid;
  grid-template-columns: 72px 1fr 52px 70px;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 7px 9px;
  border-top: 0;
  border-left: 0;
  border-right: 0;
  background: rgba(255, 255, 255, 0.01);
  color: #c8d7df;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.memory-row:hover,
.memory-row.active {
  background: rgba(0, 255, 136, 0.08);
  box-shadow: inset 2px 0 0 #00ff88;
}

.memory-row.focused {
  outline: 1px solid rgba(0, 229, 255, 0.65);
  outline-offset: -1px;
}

.ticker {
  color: #f4fbff;
  font-weight: 800;
}

.result {
  font-weight: 700;
}

.is-win,
.positive {
  color: #00ff88;
  text-shadow: 0 0 8px rgba(0, 255, 136, 0.4);
}

.is-loss,
.negative {
  color: #ff365e;
  text-shadow: 0 0 8px rgba(255, 54, 94, 0.4);
}

.is-flat {
  color: #ffd700;
}

.is-unknown,
.neutral {
  color: #8d98a5;
}

.memory-detail {
  padding: 10px;
  background:
    radial-gradient(circle at 78% 18%, rgba(0, 229, 255, 0.08), transparent 22%),
    linear-gradient(rgba(0, 229, 255, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.025) 1px, transparent 1px),
    #050505;
  background-size: auto, 48px 48px, 48px 48px;
}

.detail-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 38px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
}

.detail-result {
  font-size: 13px;
  font-weight: 900;
}

.score-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-top: 0;
}

.score-strip > div {
  display: grid;
  gap: 5px;
  min-height: 54px;
  padding: 8px 10px;
  border-right: 1px solid #20272d;
  background: rgba(255, 255, 255, 0.015);
}

.score-strip > div:last-child {
  border-right: 0;
}

.score-strip strong {
  font-size: 18px;
}

.insight-box {
  margin-top: 10px;
  padding: 10px;
  border-color: #174c36;
  background: rgba(0, 255, 136, 0.035);
}

.insight-box p {
  margin: 6px 0 0;
  color: #dfffea;
  line-height: 1.55;
}

.markdown-body {
  margin: 10px 0 0;
  min-height: 240px;
  white-space: pre-wrap;
  line-height: 1.6;
  padding: 12px;
  border: 1px solid #20272d;
  background: rgba(0, 0, 0, 0.6);
  color: #bfd0d7;
  overflow: auto;
}

@media (max-width: 900px) {
  .memory-grid {
    grid-template-columns: 1fr;
  }

  .memory-list {
    max-height: 240px;
    border-right: 0;
    border-bottom: 1px solid #20272d;
  }

  .score-strip {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
