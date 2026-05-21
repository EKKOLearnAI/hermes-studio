<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  NCard, NInput, NButton, NGrid, NGridItem, NTag, NSpin,
  NInputGroup, NAlert, NStatistic, NSpace, NDivider,
} from 'naive-ui'

interface PersonaResult {
  agent_id: string
  agent_name: string
  signal: 'bullish' | 'neutral' | 'bearish' | 'error'
  score: number
  confidence: number
  reasoning: string
  key_findings: string[]
  risks: string[]
}

interface AnalysisResult {
  ticker: string
  consensus: PersonaResult
  agents: PersonaResult[]
  timestamp: string
}

const ticker = ref('')
const augurUrl = ref('http://localhost:8000')
const loading = ref(false)
const error = ref('')
const result = ref<AnalysisResult | null>(null)

const PERSONA_LABELS: Record<string, { emoji: string; style: string }> = {
  buffett:       { emoji: '🏆', style: 'value' },
  graham:        { emoji: '📊', style: 'value' },
  lynch:         { emoji: '🚀', style: 'growth' },
  dalio:         { emoji: '🌐', style: 'macro' },
  munger:        { emoji: '🧠', style: 'value' },
  soros:         { emoji: '🔄', style: 'macro' },
  marks:         { emoji: '📉', style: 'cycle' },
  cathie_wood:   { emoji: '💡', style: 'growth' },
  fisher:        { emoji: '🔬', style: 'growth' },
  arps:          { emoji: '🥇', style: 'crypto' },
  aschenbrenner: { emoji: '🤖', style: 'tech' },
  dayu:          { emoji: '₿', style: 'crypto' },
  thiel:         { emoji: '🏢', style: 'tech' },
  duan_yongping: { emoji: '🎯', style: 'value' },
  zhang_lei:     { emoji: '🌏', style: 'growth' },
  li_lu:         { emoji: '🏔️', style: 'value' },
  dan_bin:       { emoji: '🫖', style: 'consumer' },
}

const signalColor = (signal: string) => {
  if (signal === 'bullish') return 'success'
  if (signal === 'bearish') return 'error'
  return 'warning'
}

const signalLabel = (signal: string) => {
  if (signal === 'bullish') return '看多'
  if (signal === 'bearish') return '看空'
  return '中性'
}

const consensusScore = computed(() => result.value?.consensus?.score ?? 0)
const consensusSignal = computed(() => result.value?.consensus?.signal ?? 'neutral')

async function analyze() {
  if (!ticker.value.trim()) return
  loading.value = true
  error.value = ''
  result.value = null

  try {
    const url = `${augurUrl.value.replace(/\/$/, '')}/api/analyze/${encodeURIComponent(ticker.value.trim().toUpperCase())}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!resp.ok) throw new Error(`API error: ${resp.status}`)
    const data = await resp.json()
    result.value = data
  } catch (err: any) {
    error.value = err.message?.includes('fetch') || err.name === 'TypeError'
      ? 'Augur API 未运行。请先启动: cd augur && python3 -m dashboard.app'
      : err.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="investment-view">
    <div class="view-header">
      <h1 class="view-title">🦉 Augur — 投资大师分析</h1>
      <p class="view-subtitle">17位虚拟投资大师，对同一标的给出独立评分与共识</p>
    </div>

    <NCard class="search-card">
      <NSpace vertical :size="12">
        <NInputGroup>
          <NInput
            v-model:value="ticker"
            placeholder="股票代码，如 AAPL / BRK/B / 00700.HK"
            size="large"
            style="flex: 1"
            @keydown.enter="analyze"
          />
          <NButton type="primary" size="large" :loading="loading" @click="analyze">
            分析
          </NButton>
        </NInputGroup>
        <NInput
          v-model:value="augurUrl"
          placeholder="Augur API URL"
          size="small"
          style="opacity: 0.6"
        />
      </NSpace>
    </NCard>

    <NSpin :show="loading">
      <NAlert v-if="error" type="error" title="API 错误" style="margin: 16px 0">
        {{ error }}
      </NAlert>

      <template v-if="result">
        <!-- Consensus Banner -->
        <NCard class="consensus-card" :class="`signal-${consensusSignal}`">
          <NSpace align="center" :size="24">
            <div>
              <div class="consensus-label">多Agent共识</div>
              <div class="consensus-ticker">{{ result.ticker }}</div>
            </div>
            <NStatistic
              :value="consensusScore.toFixed(1)"
              suffix=" / 10"
              label="综合评分"
            />
            <NTag :type="signalColor(consensusSignal)" size="large" round>
              {{ signalLabel(consensusSignal) }}
            </NTag>
          </NSpace>
        </NCard>

        <NDivider>17位投资大师独立评分</NDivider>

        <!-- Agent Cards Grid -->
        <NGrid :x-gap="12" :y-gap="12" cols="1 s:2 m:3 l:4" responsive="screen">
          <NGridItem v-for="agent in result.agents" :key="agent.agent_id">
            <NCard size="small" class="agent-card" :class="`signal-border-${agent.signal}`">
              <template #header>
                <div class="agent-header">
                  <span class="agent-emoji">{{ PERSONA_LABELS[agent.agent_id]?.emoji ?? '👤' }}</span>
                  <span class="agent-name">{{ agent.agent_name }}</span>
                  <NTag :type="signalColor(agent.signal)" size="tiny" round style="margin-left: auto">
                    {{ signalLabel(agent.signal) }}
                  </NTag>
                </div>
              </template>
              <div class="agent-score">
                <div class="score-bar-bg">
                  <div
                    class="score-bar-fill"
                    :class="`fill-${agent.signal}`"
                    :style="{ width: `${agent.score * 10}%` }"
                  />
                </div>
                <span class="score-text">{{ agent.score.toFixed(1) }} / 10</span>
              </div>
              <div v-if="agent.key_findings?.length" class="agent-findings">
                <div v-for="f in agent.key_findings.slice(0, 1)" :key="f" class="finding-item">
                  ✓ {{ f }}
                </div>
              </div>
              <div v-if="agent.risks?.length" class="agent-risks">
                <div v-for="r in agent.risks.slice(0, 1)" :key="r" class="risk-item">
                  ⚠ {{ r }}
                </div>
              </div>
            </NCard>
          </NGridItem>
        </NGrid>
      </template>
    </NSpin>
  </div>
</template>

<style scoped>
.investment-view {
  padding: 24px;
  max-width: 1400px;
  margin: 0 auto;
}

.view-header {
  margin-bottom: 20px;
}

.view-title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 6px;
  color: var(--n-text-color);
}

.view-subtitle {
  color: var(--n-text-color-3);
  margin: 0;
  font-size: 14px;
}

.search-card {
  margin-bottom: 20px;
}

.consensus-card {
  margin-bottom: 16px;
  border-left: 4px solid #18a058;
}

.consensus-card.signal-bullish { border-left-color: #18a058; }
.consensus-card.signal-bearish { border-left-color: #d03050; }
.consensus-card.signal-neutral { border-left-color: #f0a020; }

.consensus-label { font-size: 12px; color: var(--n-text-color-3); }
.consensus-ticker { font-size: 28px; font-weight: 700; }

.agent-card { height: 100%; }
.signal-border-bullish { border-top: 2px solid #18a058; }
.signal-border-bearish { border-top: 2px solid #d03050; }
.signal-border-neutral  { border-top: 2px solid #f0a020; }

.agent-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.agent-emoji { font-size: 16px; }
.agent-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }

.agent-score {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.score-bar-bg {
  flex: 1;
  height: 6px;
  background: var(--n-border-color);
  border-radius: 3px;
  overflow: hidden;
}

.score-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
.fill-bullish { background: #18a058; }
.fill-bearish { background: #d03050; }
.fill-neutral  { background: #f0a020; }

.score-text { font-size: 12px; font-weight: 600; white-space: nowrap; }

.agent-findings, .agent-risks { font-size: 11px; line-height: 1.5; }
.finding-item { color: #18a058; }
.risk-item    { color: #f0a020; }
</style>
