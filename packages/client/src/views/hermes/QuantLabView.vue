<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  fetchQuantLabRollingPerformance,
  fetchQuantLabStatus,
  type QuantLabRollingPerformance,
  type QuantLabRollingPerformanceResponse,
  type QuantLabStatus,
} from '@/api/hermes/quant-lab'

const loading = ref(false)
const error = ref('')
const status = ref<QuantLabStatus | null>(null)
const rollingPerformance = ref<QuantLabRollingPerformanceResponse | null>(null)

const rollingCards = computed(() => [
  { key: 'wf', label: 'WF Top5', data: rollingPerformance.value?.summaries.wf ?? null },
  { key: 'aiBottleneck', label: 'AI Bottleneck', data: rollingPerformance.value?.summaries.aiBottleneck ?? null },
  { key: 'youziCycle', label: 'Youzi Cycle', data: rollingPerformance.value?.summaries.youziCycle ?? null },
])

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  return `${(value * 100).toFixed(2)}%`
}

function formatList(items: string[]): string {
  return items.length ? items.join(', ') : 'none'
}

function latestChangeText(summary: QuantLabRollingPerformance): string {
  return `Added ${formatList(summary.latestAdded)} · Removed ${formatList(summary.latestRemoved)} · Kept ${formatList(summary.latestKept)}`
}

async function loadStatus() {
  loading.value = true
  error.value = ''

  try {
    const [statusResponse, rollingResponse] = await Promise.all([
      fetchQuantLabStatus(),
      fetchQuantLabRollingPerformance(),
    ])
    status.value = statusResponse
    rollingPerformance.value = rollingResponse
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load Quant Lab status'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadStatus()
})
</script>

<template>
  <main class="quant-lab-view">
    <section class="hero-card">
      <div>
        <p class="eyebrow">Hermes Quant Lab</p>
        <h1>Quant Lab</h1>
        <p class="subtitle">
          Foundation surface for market research, signal ranking, valuation workflows, and rolling paper performance.
        </p>
      </div>
      <button class="refresh-button" :disabled="loading" @click="loadStatus">
        {{ loading ? 'Refreshing…' : 'Refresh status' }}
      </button>
    </section>

    <section class="status-card">
      <div class="status-header">
        <h2>Service status</h2>
        <span class="status-pill" :class="{ ready: status?.ok }">
          {{ status?.ok ? 'Ready' : loading ? 'Loading' : 'Unavailable' }}
        </span>
      </div>

      <p v-if="error" class="error-message">{{ error }}</p>
      <dl v-else class="status-grid">
        <div>
          <dt>Feature</dt>
          <dd>{{ status?.feature ?? 'quant-lab' }}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{{ status?.status ?? 'foundation' }}</dd>
        </div>
        <div>
          <dt>Capabilities</dt>
          <dd>{{ status?.capabilities?.join(', ') || 'status' }}</dd>
        </div>
      </dl>
    </section>

    <section class="status-card rolling-card">
      <div class="status-header">
        <div>
          <h2>Rolling paper performance</h2>
          <p class="muted">Latest summaries from Hermes Knowledge quant-simulation outputs.</p>
        </div>
        <span class="status-pill" :class="{ ready: rollingPerformance?.ok }">
          {{ rollingPerformance?.ok ? 'Loaded' : loading ? 'Loading' : 'No data' }}
        </span>
      </div>

      <div class="rolling-grid">
        <article v-for="card in rollingCards" :key="card.key" class="rolling-summary">
          <div class="rolling-summary-header">
            <h3>{{ card.label }}</h3>
            <span>{{ card.data ? `${card.data.snapshotCount} snapshots` : 'no data' }}</span>
          </div>

          <template v-if="card.data">
            <p class="policy">{{ card.data.policy }} · {{ card.data.sourceDate }}</p>
            <dl class="metrics-grid">
              <div>
                <dt>1D Avg</dt>
                <dd>{{ formatPercent(card.data.avgReturn1d) }}</dd>
              </div>
              <div>
                <dt>5D Avg</dt>
                <dd>{{ formatPercent(card.data.avgReturn5d) }}</dd>
              </div>
              <div>
                <dt>10D Avg</dt>
                <dd>{{ formatPercent(card.data.avgReturn10d) }}</dd>
              </div>
              <div>
                <dt>Turnover</dt>
                <dd>{{ formatPercent(card.data.latestTurnover) }}</dd>
              </div>
            </dl>
            <p class="change-text">{{ latestChangeText(card.data) }}</p>
            <p class="muted">Source: {{ card.data.sourceFile }}</p>
          </template>
          <p v-else class="muted">No rolling performance summary found yet.</p>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.quant-lab-view {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: calc(100 * var(--vh));
  padding: 32px;
  background: $bg-primary;
  color: $text-primary;
}

.hero-card,
.status-card {
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
}

.hero-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 28px;
}

.eyebrow {
  margin: 0 0 8px;
  color: $accent-primary;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin: 0;
}

h1 {
  font-size: 32px;
  line-height: 1.15;
}

.subtitle {
  max-width: 680px;
  margin-top: 12px;
  color: $text-secondary;
  line-height: 1.6;
}

.refresh-button {
  border: 1px solid $accent-primary;
  border-radius: $radius-md;
  padding: 10px 14px;
  background: transparent;
  color: $accent-primary;
  cursor: pointer;
  font-weight: 600;

  &:disabled {
    cursor: wait;
    opacity: 0.65;
  }
}

.status-card {
  padding: 24px;
}

.status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.status-pill {
  border-radius: 999px;
  padding: 4px 10px;
  background: $bg-secondary;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 700;

  &.ready {
    background: rgba(34, 197, 94, 0.14);
    color: #16a34a;
  }
}

.status-grid,
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
  margin: 0;
}

.rolling-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.rolling-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.rolling-summary {
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
  background: $bg-secondary;
}

.rolling-summary-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;

  span {
    color: $text-secondary;
    font-size: 12px;
    font-weight: 700;
  }
}

.policy,
.change-text,
.muted {
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.5;
}

.policy,
.metrics-grid,
.change-text {
  margin-top: 12px;
}

dt {
  color: $text-secondary;
  font-size: 12px;
  text-transform: uppercase;
}

dd {
  margin: 6px 0 0;
  font-weight: 600;
}

.error-message {
  color: $error;
}
</style>
