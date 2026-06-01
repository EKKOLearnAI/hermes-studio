<script setup lang="ts">
import { computed } from 'vue'
import { MIROFISH_SAFE_GATEWAY_ALERT, type RunQuantLabMiroFishResult } from '@/api/hermes/quant-lab'

type PipelineStatus = 'complete' | 'running' | 'waiting'

interface PipelineStep {
  id: string
  title: string
  description: string
  status: PipelineStatus
  tags: string[]
  meta: Array<{ label: string; value: string }>
}

const props = withDefaults(defineProps<{
  ticker?: string
  topic?: string
  projectId?: string
  graphPath?: string
  liveResult?: RunQuantLabMiroFishResult | null
}>(), {
  ticker: '',
  topic: '',
  projectId: 'preview-project',
  graphPath: '/process/preview-project',
  liveResult: null,
})

const targetLabel = computed(() => {
  const ticker = props.liveResult?.topPicks?.[0]?.ticker || props.ticker || ''
  if (ticker) return String(ticker).trim().toUpperCase()
  return props.topic ? props.topic.slice(0, 32) : 'MARKET'
})

const evidenceCount = computed(() => props.liveResult?.evidenceCount || props.liveResult?.mirofish?.inference?.evidenceCount || 0)
const graphReady = computed(() => Boolean(props.liveResult?.mirofish?.evidenceArchive?.graphOk || evidenceCount.value))
const debateReady = computed(() => Boolean(props.liveResult?.mirofish?.inference?.debate))
const topAction = computed(() => props.liveResult?.topPicks?.[0]?.action || 'Pending')
const safeModeActive = computed(() => props.liveResult?.source === 'aurora-safe-mode' ||
  props.liveResult?.mirofish?.status === 'safe_mode' ||
  props.liveResult?.mirofish?.inference?.error === MIROFISH_SAFE_GATEWAY_ALERT)
const generatedAt = computed(() => {
  const value = props.liveResult?.generatedAt
  if (!value) return 'awaiting hydration'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'live'
  return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
})

const entityTags = computed(() => [
  'Scenario',
  'Control',
  props.topic ? 'Topic' : 'Ticker',
  targetLabel.value,
  'MacroRegime',
  'RiskGate',
  'Evidence',
  'Verdict',
])

const steps = computed<PipelineStep[]>(() => [
  {
    id: '01',
    title: '01 本體構建',
    description: '建立 Scenario、Control、Ticker 與風控節點，準備讓 GraphRAG 對推演語境有穩定本體。',
    status: 'complete',
    tags: entityTags.value,
    meta: [
      { label: 'Project', value: props.projectId },
      { label: props.topic ? 'Topic' : 'Asset', value: targetLabel.value },
    ],
  },
  {
    id: '02',
    title: '02 GraphRAG 構建',
    description: '將本體節點、候選證據、macro gate 與 edge 關係注入預覽圖譜，作為推演前的檢索底座。',
    status: graphReady.value ? 'complete' : 'running',
    tags: ['Nodes', 'Edges', 'Evidence Pack', 'Risk Links'],
    meta: [
      { label: 'Nodes', value: '6' },
      { label: 'Edges', value: '5' },
    ],
  },
  {
    id: '03',
    title: '03 推演預檢',
    description: '確認沙盒為 read-only、backend submit 關閉，然後才進入 MiroFish 多代理辯論。',
    status: debateReady.value ? 'complete' : 'running',
    tags: ['Read-only', 'No Trade Submit', 'Audit Ready'],
    meta: [
      { label: 'Action', value: topAction.value },
      { label: 'Mode', value: props.liveResult?.mirofish?.inference?.debate?.mode || 'local' },
    ],
  },
])

const terminalLines = computed(() => {
  const lines = [
    `[aurora:mirofish] project=${props.projectId} graph=${props.graphPath}`,
    `[ontology] entity types hydrated: ${entityTags.value.join(', ')}`,
    `[graphrag] Preview graph hydrated... Nodes: 6, Edges: 5`,
    `[evidence] archive signals=${evidenceCount.value || 'pending'} target=${targetLabel.value}`,
  ]
  if (safeModeActive.value) {
    lines.push(MIROFISH_SAFE_GATEWAY_ALERT)
  }
  if (props.liveResult) {
    lines.push(`[sandbox] live result synced at ${generatedAt.value}; action=${topAction.value}`)
  } else {
    lines.push('[sandbox] waiting for MiroFish debate hydration...')
  }
  return lines
})

function statusLabel(status: PipelineStatus): string {
  if (status === 'complete') return '已完成'
  if (status === 'running') return '進行中'
  return '等待中'
}
</script>

<template>
  <section class="graphrag-pipeline" aria-label="GraphRAG Build Pipeline">
    <header class="pipeline-heading">
      <div>
        <p>GraphRAG Build Pipeline</p>
        <h2>推演前構建檢查</h2>
        <span>先完成本體、圖譜與沙盒預檢，再進入 MiroFish Debate Arena。</span>
      </div>
      <div class="pipeline-stats" aria-label="GraphRAG stats">
        <article>
          <strong>6</strong>
          <span>Nodes</span>
        </article>
        <i></i>
        <article>
          <strong>5</strong>
          <span>Edges</span>
        </article>
      </div>
    </header>

    <div class="pipeline-steps">
      <article
        v-for="step in steps"
        :key="step.id"
        class="pipeline-card"
        :class="step.status"
      >
        <div class="pipeline-card-main">
          <div>
            <p>{{ step.id }}</p>
            <h3>{{ step.title }}</h3>
            <span>{{ step.description }}</span>
          </div>
          <strong class="status-pill" :class="step.status">{{ statusLabel(step.status) }}</strong>
        </div>

        <div class="pipeline-tags" aria-label="Generated entity types">
          <span v-for="tag in step.tags" :key="`${step.id}-${tag}`">{{ tag }}</span>
        </div>

        <div class="pipeline-meta">
          <article v-for="item in step.meta" :key="`${step.id}-${item.label}`">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
        </div>
      </article>
    </div>

    <section class="pipeline-terminal" aria-label="GraphRAG hydration terminal">
      <div class="terminal-titlebar">
        <span></span>
        <span></span>
        <span></span>
        <strong>system.dashboard</strong>
      </div>
      <pre><code><span v-for="line in terminalLines" :key="line">$ {{ line }}
</span></code></pre>
    </section>
  </section>
</template>

<style scoped lang="scss">
.graphrag-pipeline {
  position: relative;
  display: grid;
  gap: 16px;
  width: min(980px, calc(100% - 28px));
  max-height: calc(100vh - 146px);
  margin: 0 auto;
  padding: 18px;
  overflow: auto;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 32px;
  color: rgba(248, 250, 252, 0.94);
  background:
    radial-gradient(680px 420px at 26% 0%, rgba(99, 102, 241, 0.16), transparent 64%),
    rgba(15, 23, 42, 0.6);
  box-shadow: 0 28px 90px rgba(2, 6, 23, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  pointer-events: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.32) transparent;
}

.pipeline-heading,
.pipeline-card-main,
.pipeline-meta,
.terminal-titlebar {
  display: grid;
  align-items: center;
}

.pipeline-heading {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px;
}

.pipeline-heading p,
.pipeline-heading h2,
.pipeline-heading span,
.pipeline-card p,
.pipeline-card h3,
.pipeline-card span,
.pipeline-terminal pre,
.pipeline-terminal code {
  margin: 0;
}

.pipeline-heading p,
.pipeline-card p,
.pipeline-meta span {
  color: rgba(125, 211, 252, 0.78);
  font-size: 10px;
  font-weight: 950;
  letter-spacing: 0.08em;
  line-height: 1.1;
  text-transform: uppercase;
}

.pipeline-heading h2 {
  margin-top: 6px;
  color: #fff;
  font-size: clamp(24px, 4vw, 42px);
  font-weight: 950;
  letter-spacing: 0;
  line-height: 1;
}

.pipeline-heading > div:first-child > span,
.pipeline-card-main > div > span {
  display: block;
  margin-top: 8px;
  color: rgba(203, 213, 225, 0.78);
  font-size: 13px;
  font-weight: 720;
  line-height: 1.45;
}

.pipeline-stats {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 194px;
  justify-content: center;
  padding: 12px 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.055);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);
}

.pipeline-stats article {
  display: grid;
  justify-items: center;
  gap: 4px;
}

.pipeline-stats strong {
  color: #f8fafc;
  font-size: 26px;
  font-weight: 950;
  line-height: 1;
}

.pipeline-stats span {
  color: rgba(203, 213, 225, 0.66);
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
}

.pipeline-stats i {
  width: 1px;
  height: 32px;
  background: rgba(255, 255, 255, 0.14);
}

.pipeline-steps {
  display: grid;
  gap: 12px;
}

.pipeline-card {
  display: grid;
  gap: 13px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 24px;
  background: rgba(15, 23, 42, 0.6);
  box-shadow: 0 18px 48px rgba(2, 6, 23, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

.pipeline-card.complete {
  box-shadow: 0 18px 48px rgba(2, 6, 23, 0.24), inset 0 0 28px rgba(16, 185, 129, 0.08);
}

.pipeline-card.running {
  box-shadow: 0 18px 48px rgba(2, 6, 23, 0.24), inset 0 0 28px rgba(248, 113, 113, 0.08);
}

.pipeline-card-main {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
}

.pipeline-card h3 {
  margin-top: 5px;
  color: #fff;
  font-size: 18px;
  font-weight: 940;
  letter-spacing: 0;
  line-height: 1.1;
}

.status-pill {
  display: inline-grid;
  min-height: 34px;
  place-items: center;
  padding: 0 13px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 950;
  line-height: 1;
}

.status-pill.complete {
  color: #34d399;
  background: rgba(16, 185, 129, 0.1);
  box-shadow: 0 0 22px rgba(52, 211, 153, 0.18);
}

.status-pill.running {
  color: #fb7185;
  background: rgba(244, 63, 94, 0.1);
  box-shadow: 0 0 22px rgba(251, 113, 133, 0.18);
}

.status-pill.waiting {
  color: #cbd5e1;
  background: rgba(148, 163, 184, 0.1);
}

.pipeline-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pipeline-tags span {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  color: rgba(226, 232, 240, 0.8);
  background: rgba(255, 255, 255, 0.1);
  font-size: 11px;
  font-weight: 850;
}

.pipeline-meta {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.pipeline-meta article {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.055);
}

.pipeline-meta strong {
  overflow: hidden;
  color: rgba(248, 250, 252, 0.94);
  font-size: 13px;
  font-weight: 930;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pipeline-terminal {
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 22px;
  background: rgba(0, 0, 0, 0.9);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.terminal-titlebar {
  grid-template-columns: auto auto auto minmax(0, 1fr);
  gap: 7px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(15, 23, 42, 0.6);
}

.terminal-titlebar span {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}

.terminal-titlebar span:nth-child(1) {
  background: #fb7185;
}

.terminal-titlebar span:nth-child(2) {
  background: #fbbf24;
}

.terminal-titlebar span:nth-child(3) {
  background: #34d399;
}

.terminal-titlebar strong {
  margin-left: 6px;
  color: rgba(203, 213, 225, 0.72);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  font-weight: 760;
}

.pipeline-terminal pre {
  padding: 14px 16px 16px;
  overflow: auto;
  color: rgba(148, 163, 184, 0.92);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  font-weight: 680;
  line-height: 1.7;
  white-space: pre-wrap;
}

@media (max-width: 760px) {
  .graphrag-pipeline,
  .pipeline-heading,
  .pipeline-card-main,
  .pipeline-meta {
    grid-template-columns: 1fr;
  }

  .pipeline-stats {
    width: 100%;
  }
}
</style>
