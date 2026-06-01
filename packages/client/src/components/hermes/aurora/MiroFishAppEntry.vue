<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import GraphRAGPipeline from '@/components/hermes/aurora/GraphRAGPipeline.vue'
import MiroFishArena from '@/components/hermes/aurora/MiroFishArena.vue'
import MiroFishCosmicCanvas, { type MiroFishFocusPath } from '@/components/hermes/aurora/MiroFishCosmicCanvas.vue'
import TradingViewPanel from '@/components/hermes/aurora/TradingViewPanel.vue'
import { auroraEventBus, type AuroraEventEnvelope } from '@/services/hermes/aurora/aurora-event-bus'
import type { QuantLabTopPick, RunQuantLabMiroFishResult } from '@/api/hermes/quant-lab'

type MiroFishViewMode = 'graph' | 'pipeline' | 'workbench'

interface MiroFishLaunchContext {
  source: 'aurora-omnibar' | 'aurora-memory-stream' | 'quant-risk-bridge' | 'quant-risk-bridge-batch'
  targetTicker?: string
  topic?: string
  memoryRecordId?: string
  memoryRecordPath?: string
  pick?: Partial<QuantLabTopPick>
  batchPicks?: Partial<QuantLabTopPick>[]
  batchLimit?: number
  snapshotSource?: string
  snapshotGeneratedAt?: string
  decision?: {
    action?: string
    conclusion?: string
    invalidation?: string
  }
  marketPulse?: Array<{ label: string; value: string; tone?: string }>
}

const props = withDefaults(defineProps<{
  query?: string
  projectId?: string
  graphPath?: string
  initialUrl?: string
  initialView?: MiroFishViewMode
  launchContext?: MiroFishLaunchContext | null
}>(), {
  query: '',
  projectId: 'preview-project',
  graphPath: '/process/preview-project',
  initialUrl: '',
  initialView: 'graph',
  launchContext: null,
})

function normalizeViewMode(view: unknown): MiroFishViewMode {
  return view === 'pipeline' || view === 'workbench' || view === 'graph'
    ? view
    : 'graph'
}

const activeFocusPath = ref<MiroFishFocusPath>('verdict')
const currentView = ref<MiroFishViewMode>(normalizeViewMode(props.initialView))
const liveMiroFishResult = shallowRef<RunQuantLabMiroFishResult | null>(null)
const isLiveChartOpen = ref(false)
const ipcQueuedTopic = ref('')
let unsubscribePageAnalyzed: (() => void) | null = null
const viewOptions: Array<{ key: MiroFishViewMode; label: string; detail: string }> = [
  { key: 'graph', label: '圖譜', detail: 'Canvas' },
  { key: 'pipeline', label: '構建', detail: 'Pipeline' },
  { key: 'workbench', label: '工作台', detail: 'Arena' },
]
const focusOptions: Array<{ key: MiroFishFocusPath; label: string; detail: string }> = [
  { key: 'macro', label: 'Macro', detail: 'Regime' },
  { key: 'bull', label: 'Bull', detail: 'Upside' },
  { key: 'bear', label: 'Bear', detail: 'Risk' },
  { key: 'verdict', label: 'Verdict', detail: 'Synth' },
]

const targetTicker = computed(() => {
  const ticker = props.launchContext?.targetTicker || props.launchContext?.pick?.ticker || ''
  return String(ticker || '').trim().toUpperCase()
})
const targetTopic = computed(() => String(props.launchContext?.topic || props.query || '').trim())
const targetLabel = computed(() => targetTicker.value || targetTopic.value || 'Market')
const chartSymbol = computed(() => {
  const firstPick = liveMiroFishResult.value?.topPicks?.[0]?.ticker
  return targetTicker.value || String(firstPick || '').trim().toUpperCase() || 'NVDA'
})
const initialMemoryRecordId = computed(() => String(props.launchContext?.memoryRecordId || props.launchContext?.memoryRecordPath || '').trim())

const arenaLaunchContext = computed<MiroFishLaunchContext | null>(() => {
  if (props.launchContext) {
    return {
      ...props.launchContext,
      ...(targetTicker.value ? { targetTicker: targetTicker.value } : {}),
      ...(targetTopic.value ? { topic: targetTopic.value } : {}),
    }
  }
  if (!targetTicker.value && !targetTopic.value) return null
  return {
    source: 'aurora-omnibar',
    ...(targetTicker.value ? { targetTicker: targetTicker.value } : {}),
    ...(targetTopic.value ? { topic: targetTopic.value } : {}),
  }
})

function setFocusPath(path: MiroFishFocusPath) {
  activeFocusPath.value = path
}

function setCurrentView(view: MiroFishViewMode) {
  currentView.value = view
}

function toggleLiveChart() {
  isLiveChartOpen.value = !isLiveChartOpen.value
}

function handleResultChange(nextResult: RunQuantLabMiroFishResult | null) {
  liveMiroFishResult.value = nextResult
}

function queueBackgroundSimulation(event: AuroraEventEnvelope<'PAGE_ANALYZED'>) {
  const topic = event.payload.topic || event.payload.title || event.payload.url
  if (!topic) return
  ipcQueuedTopic.value = topic
  auroraEventBus.publish('MIROFISH_BACKGROUND_SIMULATION_QUEUED', {
    topic,
    source: 'PAGE_ANALYZED',
    url: event.payload.url,
    queuedAt: new Date().toISOString(),
  })
}

watch(() => props.initialView, (nextView) => {
  currentView.value = normalizeViewMode(nextView)
})

watch(targetTicker, (nextTicker, previousTicker) => {
  if (isLiveChartOpen.value && nextTicker && nextTicker !== previousTicker) {
    activeFocusPath.value = 'verdict'
  }
})

onMounted(() => {
  unsubscribePageAnalyzed = auroraEventBus.subscribe('PAGE_ANALYZED', queueBackgroundSimulation)
})

onBeforeUnmount(() => {
  unsubscribePageAnalyzed?.()
  unsubscribePageAnalyzed = null
})
</script>

<template>
  <section class="mirofish-app-entry" :class="`view-${currentView}`" aria-label="MiroFish Aurora App">
    <header class="mirofish-app-hero">
      <div>
        <p>Aurora OS Native App</p>
        <h1>MiroFish Grand Merge</h1>
        <span>Cosmic Canvas, multi-agent debate, and Hermes Synthesizer verdict in one immersive workspace.</span>
      </div>
      <nav class="view-mode-rail" aria-label="MiroFish top navigation views">
        <button
          v-for="option in viewOptions"
          :key="option.key"
          type="button"
          :class="{ active: currentView === option.key }"
          :aria-pressed="currentView === option.key"
          @click="setCurrentView(option.key)"
        >
          <strong>{{ option.label }}</strong>
          <span>{{ option.detail }}</span>
        </button>
      </nav>
      <div class="mirofish-app-meta">
        <span>Read-only sandbox</span>
        <div>
          <button
            class="live-chart-toggle"
            type="button"
            :class="{ active: isLiveChartOpen }"
            :aria-pressed="isLiveChartOpen"
            @click="toggleLiveChart"
          >
            Live Chart
          </button>
          <strong>{{ targetLabel }}</strong>
        </div>
      </div>
      <Transition name="mirofish-fade">
        <div v-if="ipcQueuedTopic" class="mirofish-ipc-pill" role="status">
          <span aria-hidden="true"></span>
          <strong>IPC queued</strong>
          <em>{{ ipcQueuedTopic }}</em>
        </div>
      </Transition>
      <nav class="focus-sync-rail" aria-label="MiroFish shared graph focus">
        <button
          v-for="option in focusOptions"
          :key="option.key"
          type="button"
          :class="{ active: activeFocusPath === option.key }"
          :aria-pressed="activeFocusPath === option.key"
          @click="setFocusPath(option.key)"
        >
          <strong>{{ option.label }}</strong>
          <span>{{ option.detail }}</span>
        </button>
      </nav>
    </header>

    <Transition name="mirofish-fade">
      <section v-if="currentView !== 'workbench'" class="cosmic-canvas-stage" aria-label="Cosmic Canvas Knowledge Graph">
        <div class="stage-label">
          <span>01</span>
          <div>
            <strong>Cosmic Canvas</strong>
            <small>Inference path and knowledge graph</small>
          </div>
        </div>
        <MiroFishCosmicCanvas
          :ticker="targetTicker"
          :topic="targetTopic"
          :initial-memory-record-id="initialMemoryRecordId"
          :focus-path="activeFocusPath"
          :live-result="liveMiroFishResult"
          :project-id="projectId"
          :graph-path="graphPath"
        />
      </section>
    </Transition>

    <Transition name="mirofish-fade">
      <section v-if="currentView === 'pipeline'" class="pipeline-stage" aria-label="GraphRAG Build Pipeline">
        <GraphRAGPipeline
          :ticker="targetTicker"
          :topic="targetTopic"
          :project-id="projectId"
          :graph-path="graphPath"
          :live-result="liveMiroFishResult"
        />
      </section>
    </Transition>

    <Transition name="mirofish-fade">
      <section v-if="currentView === 'workbench'" class="debate-stage" aria-label="MiroFish Debate Arena and Final Verdict">
        <div class="stage-label debate-label">
          <span>02</span>
          <div>
            <strong>Debate Arena</strong>
            <small>Macro, Bull, Bear, then Final Verdict</small>
          </div>
        </div>
        <MiroFishArena
          :launch-context="arenaLaunchContext"
          @focus-path="setFocusPath"
          @result-change="handleResultChange"
        />
      </section>
    </Transition>

    <Transition name="live-chart-slide">
      <TradingViewPanel
        v-if="isLiveChartOpen"
        class="mirofish-live-chart"
        :symbol="chartSymbol"
        @close="isLiveChartOpen = false"
      />
    </Transition>

  </section>
</template>

<style scoped lang="scss">
.mirofish-app-entry {
  --mirofish-glass: var(--aurora-glass-bg, rgba(255, 255, 255, 0.08));
  --mirofish-glass-strong: var(--aurora-glass-bg-strong, rgba(255, 255, 255, 0.12));
  --mirofish-border: var(--aurora-glass-border, rgba(255, 255, 255, 0.16));
  --mirofish-shadow: var(--aurora-glass-shadow, 0 24px 80px rgba(2, 6, 23, 0.28));
  --mirofish-text: var(--aurora-text, rgba(248, 250, 252, 0.94));
  --mirofish-muted: var(--aurora-muted, rgba(203, 213, 225, 0.66));

  position: relative;
  display: block;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  color: var(--mirofish-text);
  background:
    radial-gradient(940px 620px at 50% 20%, rgba(79, 70, 229, 0.2), transparent 64%),
    linear-gradient(135deg, rgba(2, 6, 23, 0.94), rgba(15, 23, 42, 0.82));
  font-family: Poppins, "Noto Sans TC", "Noto Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.mirofish-app-hero,
.cosmic-canvas-stage,
.pipeline-stage,
.debate-stage {
  position: absolute;
}

.mirofish-app-hero {
  top: 18px;
  left: 50%;
  z-index: 20;
  display: grid;
  grid-template-columns: minmax(170px, 1fr) minmax(260px, 0.9fr) auto auto minmax(320px, 1.05fr);
  align-items: center;
  gap: 14px;
  width: min(1180px, calc(100% - 120px));
  padding: 12px 14px;
  border: 1px solid var(--mirofish-border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.045);
  box-shadow: 0 22px 70px rgba(2, 6, 23, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  pointer-events: auto;
  transform: translateX(-50%);
}

.view-mode-rail {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  min-width: 0;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  background: rgba(2, 6, 23, 0.22);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.view-mode-rail button {
  display: grid;
  gap: 3px;
  min-width: 0;
  min-height: 42px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  color: rgba(226, 232, 240, 0.62);
  background: transparent;
  cursor: pointer;
  text-align: center;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.view-mode-rail button:hover,
.view-mode-rail button:focus-visible,
.view-mode-rail button.active {
  border-color: rgba(251, 146, 60, 0.52);
  color: #fff7ed;
  background: rgba(251, 146, 60, 0.15);
  box-shadow: 0 0 28px rgba(251, 146, 60, 0.16), inset 0 0 20px rgba(251, 146, 60, 0.09);
  outline: none;
}

.focus-sync-rail {
  grid-column: auto;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  min-width: 0;
}

.focus-sync-rail button {
  display: grid;
  gap: 4px;
  min-width: 0;
  min-height: 42px;
  padding: 7px 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  color: rgba(226, 232, 240, 0.72);
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
  text-align: left;
  transition: all 0.24s cubic-bezier(0.4, 0, 0.2, 1);
}

.focus-sync-rail button:hover,
.focus-sync-rail button:focus-visible,
.focus-sync-rail button.active {
  border-color: rgba(129, 140, 248, 0.34);
  background: rgba(129, 140, 248, 0.14);
  box-shadow: 0 12px 32px rgba(79, 70, 229, 0.16);
  color: #fff;
  outline: none;
  transform: translateY(-1px);
}

.view-mode-rail strong,
.view-mode-rail span,
.focus-sync-rail strong,
.focus-sync-rail span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.view-mode-rail strong,
.focus-sync-rail strong {
  font-size: 12px;
  font-weight: 920;
  line-height: 1;
}

.view-mode-rail span,
.focus-sync-rail span {
  color: rgba(203, 213, 225, 0.56);
  font-size: 10px;
  font-weight: 800;
  line-height: 1;
}

.mirofish-app-hero p,
.mirofish-app-hero h1,
.mirofish-app-hero span {
  margin: 0;
}

.mirofish-app-hero p,
.stage-label small,
.mirofish-app-meta span {
  color: rgba(191, 219, 254, 0.76);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
  line-height: 1.1;
  text-transform: uppercase;
}

.mirofish-app-hero h1 {
  color: #fff;
  font-size: 18px;
  font-weight: 950;
  letter-spacing: 0;
  line-height: 1;
}

.mirofish-app-hero > div:first-child > span {
  display: none;
  color: var(--mirofish-muted);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
}

.mirofish-app-meta {
  display: grid;
  min-width: 128px;
  justify-items: end;
  gap: 8px;
}

.mirofish-app-meta > div {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.live-chart-toggle {
  display: inline-grid;
  min-height: 42px;
  place-items: center;
  padding: 0 13px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  color: rgba(226, 232, 240, 0.78);
  background: rgba(255, 255, 255, 0.055);
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
  line-height: 1;
  transition: all 0.24s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
}

.live-chart-toggle:hover,
.live-chart-toggle:focus-visible,
.live-chart-toggle.active {
  border-color: rgba(56, 189, 248, 0.42);
  color: #e0f2fe;
  background: rgba(14, 165, 233, 0.16);
  box-shadow: 0 0 30px rgba(56, 189, 248, 0.16), inset 0 0 18px rgba(56, 189, 248, 0.08);
  outline: none;
}

.mirofish-app-meta strong {
  display: inline-grid;
  min-height: 42px;
  min-width: 92px;
  place-items: center;
  padding: 0 14px;
  border: 1px solid rgba(129, 140, 248, 0.28);
  border-radius: 999px;
  color: #e0f2fe;
  background: rgba(99, 102, 241, 0.18);
  box-shadow: 0 0 34px rgba(129, 140, 248, 0.18);
  font-size: 15px;
  font-weight: 950;
}

.mirofish-ipc-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 210px;
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid rgba(45, 212, 191, 0.18);
  border-radius: 999px;
  color: rgba(204, 251, 241, 0.9);
  background: rgba(20, 184, 166, 0.08);
  box-shadow: 0 0 26px rgba(20, 184, 166, 0.1);
  font-size: 10px;
  font-weight: 900;
  line-height: 1;
}

.mirofish-ipc-pill > span {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: #5eead4;
  box-shadow: 0 0 16px rgba(94, 234, 212, 0.56);
}

.mirofish-ipc-pill strong,
.mirofish-ipc-pill em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mirofish-ipc-pill em {
  min-width: 0;
  max-width: 105px;
  color: rgba(204, 251, 241, 0.66);
  font-style: normal;
}

.mirofish-live-chart {
  position: absolute;
  top: 112px;
  right: 18px;
  bottom: 24px;
  z-index: 30;
  width: min(440px, calc(100% - 36px));
  pointer-events: auto;
}

.live-chart-slide-enter-active,
.live-chart-slide-leave-active {
  transition:
    opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}

.live-chart-slide-enter-from,
.live-chart-slide-leave-to {
  opacity: 0;
  transform: translateX(22px) scale(0.98);
}

.live-chart-slide-enter-to,
.live-chart-slide-leave-from {
  opacity: 1;
  transform: translateX(0) scale(1);
}

.cosmic-canvas-stage,
.pipeline-stage,
.debate-stage {
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.cosmic-canvas-stage {
  inset: 0;
  z-index: 0;
  min-height: 100%;
  pointer-events: auto;
}

.debate-stage {
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  display: grid;
  max-height: min(calc(var(--vh) * 78), calc(100% - 110px));
  padding: 0 clamp(14px, 2.4vw, 34px) clamp(16px, 2.6vw, 36px);
  pointer-events: none;
}

.pipeline-stage {
  top: 126px;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 12;
  display: grid;
  align-content: start;
  justify-items: center;
  padding: 0 clamp(14px, 2.5vw, 36px) clamp(18px, 3vw, 40px);
  overflow: auto;
  pointer-events: none;
}

.view-graph .cosmic-canvas-stage {
  z-index: 1;
}

.view-graph .cosmic-canvas-stage :deep(.cosmic-data-pill) {
  top: 76px;
}

.view-graph .cosmic-canvas-stage :deep(.cosmic-sync-card) {
  top: 90px;
}

.view-workbench {
  background:
    radial-gradient(920px 540px at 50% 12%, rgba(99, 102, 241, 0.18), transparent 66%),
    radial-gradient(760px 460px at 82% 72%, rgba(16, 185, 129, 0.08), transparent 64%),
    linear-gradient(135deg, rgba(2, 6, 23, 0.98), rgba(15, 23, 42, 0.9));
}

.view-workbench .debate-stage {
  top: 116px;
  right: clamp(16px, 3vw, 44px);
  bottom: clamp(16px, 3vw, 44px);
  left: clamp(16px, 3vw, 44px);
  align-content: stretch;
  max-height: none;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 34px;
  background:
    radial-gradient(760px 520px at 30% 0%, rgba(99, 102, 241, 0.16), transparent 68%),
    radial-gradient(740px 520px at 80% 100%, rgba(16, 185, 129, 0.08), transparent 66%),
    rgba(255, 255, 255, 0.028);
  box-shadow: 0 28px 90px rgba(2, 6, 23, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  pointer-events: none;
}

.view-workbench .debate-stage :deep(.mirofish-arena) {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: 100%;
  gap: clamp(12px, 1.6vh, 20px);
  padding: clamp(16px, 2vh, 24px) clamp(18px, 2.4vw, 34px) clamp(18px, 2.4vh, 34px);
  overflow: hidden;
  background: transparent;
}

.view-workbench .debate-stage :deep(.arena-hero),
.view-workbench .debate-stage :deep(.arena-status) {
  display: none;
  width: min(1380px, 100%);
}

.view-workbench .debate-stage :deep(.agent-grid) {
  flex: 0 0 auto;
  width: min(1480px, 100%);
  gap: clamp(12px, 1.8vw, 24px);
  min-height: 0;
  margin-top: 0;
}

.view-workbench .debate-stage :deep(.agent-card) {
  grid-template-rows: auto auto minmax(76px, 1fr) auto;
  gap: clamp(8px, 1vh, 14px);
  min-height: clamp(228px, 31vh, 380px);
  padding: clamp(14px, 1.45vw, 22px);
}

.view-workbench .debate-stage :deep(.agent-avatar) {
  width: 48px;
  height: 48px;
  border-radius: 18px;
  font-size: 24px;
}

.view-workbench .debate-stage :deep(.agent-header h2) {
  font-size: clamp(16px, 1.45vw, 21px);
}

.view-workbench .debate-stage :deep(.agent-content) {
  max-height: clamp(82px, 12vh, 170px);
  padding: 12px;
  font-size: 12px;
  line-height: 1.48;
}

.view-workbench .debate-stage :deep(.agent-points span) {
  padding: 5px 8px;
  font-size: 10px;
}

.view-workbench .debate-stage :deep(.scenario-drilldown.core-agent-delta) {
  flex: 0 0 auto;
  max-height: clamp(156px, 23vh, 224px);
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.3) transparent;
}

.view-workbench .debate-stage :deep(.audit-gallery),
.view-workbench .debate-stage :deep(.audit-replay-card),
.view-workbench .debate-stage :deep(.quant-bridge-card),
.view-workbench .debate-stage :deep(.quant-bridge-batch-card),
.view-workbench .debate-stage :deep(.advanced-settings-drawer),
.view-workbench .debate-stage :deep(.scenario-presets),
.view-workbench .debate-stage :deep(.scenario-matrix),
.view-workbench .debate-stage :deep(.decision-timeline-panel),
.view-workbench .debate-stage :deep(.archive-panel) {
  display: none !important;
}

.view-workbench .debate-stage :deep(.scenario-drilldown-heading h3) {
  font-size: clamp(18px, 1.8vw, 26px);
}

.view-workbench .debate-stage :deep(.scenario-drilldown-grid) {
  gap: clamp(10px, 1.4vw, 14px);
}

.view-workbench .debate-stage :deep(.scenario-drilldown-point) {
  gap: 8px;
  padding: 12px;
}

.view-workbench .debate-stage :deep(.scenario-drilldown-point p) {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.view-workbench .debate-stage :deep(.verdict-panel) {
  position: absolute;
  right: clamp(18px, 2.4vw, 34px);
  bottom: clamp(18px, 2.4vw, 34px);
  width: min(360px, calc(100% - 36px));
  max-height: clamp(130px, 18vh, 180px);
  margin: 0;
  padding: 16px;
  overflow: hidden;
  grid-template-columns: 1fr;
  gap: 10px;
  pointer-events: auto;
}

.view-workbench .debate-stage :deep(.verdict-scenario-grid) {
  display: none;
}

.view-workbench .debate-stage :deep(.verdict-copy h2) {
  font-size: 22px;
}

.view-workbench .debate-stage :deep(.verdict-copy span) {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.view-workbench .debate-stage :deep(.verdict-metrics) {
  grid-template-columns: 1fr;
}

.view-workbench .debate-stage :deep(.verdict-metrics article:not(.verdict-action-card)) {
  display: none;
}

.view-pipeline .cosmic-canvas-stage {
  opacity: 0.15;
  filter: saturate(0.72) brightness(0.64);
  pointer-events: none;
}

.view-pipeline::after {
  position: absolute;
  inset: 0;
  z-index: 8;
  background:
    radial-gradient(820px 520px at 50% 30%, rgba(15, 23, 42, 0.46), transparent 70%),
    linear-gradient(180deg, rgba(2, 6, 23, 0.46), rgba(2, 6, 23, 0.78));
  content: "";
  pointer-events: none;
}

.view-pipeline .cosmic-canvas-stage :deep(.cosmic-data-pill) {
  top: 76px;
}

.view-pipeline .cosmic-canvas-stage :deep(.cosmic-sync-card),
.view-pipeline .cosmic-canvas-stage :deep(.cosmic-detail-card) {
  opacity: 0.58;
}

.view-pipeline .pipeline-stage {
  pointer-events: none;
}

.mirofish-fade-enter-active,
.mirofish-fade-leave-active {
  transition:
    opacity 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
}

.mirofish-fade-enter-from,
.mirofish-fade-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.992);
}

.mirofish-fade-enter-to,
.mirofish-fade-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.stage-label {
  display: none;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  max-width: min(360px, calc(100% - 32px));
  padding: 9px 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.46);
  box-shadow: 0 16px 40px rgba(2, 6, 23, 0.22);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.stage-label span {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 999px;
  color: #020617;
  background: #a7f3d0;
  font-size: 11px;
  font-weight: 950;
}

.stage-label strong,
.stage-label small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-label strong {
  color: #f8fafc;
  font-size: 12px;
  font-weight: 920;
  line-height: 1.1;
}

.stage-label small {
  margin-top: 3px;
  color: rgba(203, 213, 225, 0.7);
  font-size: 9px;
}

.debate-label {
  top: 18px;
}

.cosmic-canvas-stage :deep(.mirofish-cosmic-canvas) {
  height: 100%;
  min-height: 100%;
}

.cosmic-canvas-stage :deep(.cosmic-data-pill) {
  top: 72px;
  left: 24px;
}

.debate-stage :deep(.mirofish-arena) {
  display: grid;
  align-content: start;
  max-height: min(calc(var(--vh) * 78), calc((var(--vh) * 100) - 126px));
  min-height: 0;
  padding: 0 0 clamp(28px, 4vh, 60px);
  overflow-x: visible;
  overflow-y: auto;
  pointer-events: none;
  background:
    linear-gradient(to bottom, transparent, rgba(2, 6, 23, 0.12) 34%, rgba(2, 6, 23, 0.22));
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
}

.debate-stage :deep(.mirofish-arena::before) {
  display: none;
}

.debate-stage :deep(.arena-hero),
.debate-stage :deep(.arena-status),
.debate-stage :deep(.audit-gallery),
.debate-stage :deep(.audit-replay-card),
.debate-stage :deep(.quant-bridge-card),
.debate-stage :deep(.quant-bridge-batch-card),
.debate-stage :deep(.advanced-settings-drawer),
.debate-stage :deep(.scenario-presets),
.debate-stage :deep(.scenario-matrix),
.debate-stage :deep(.decision-timeline-panel),
.debate-stage :deep(.archive-panel),
.debate-stage :deep(.agent-card),
.debate-stage :deep(.verdict-panel),
.debate-stage :deep(button),
.debate-stage :deep(input),
.debate-stage :deep(select),
.debate-stage :deep(textarea) {
  pointer-events: auto;
}

.debate-stage :deep(.agent-grid) {
  pointer-events: none;
}

.debate-stage :deep(.arena-hero),
.debate-stage :deep(.arena-status),
.debate-stage :deep(.agent-card),
.debate-stage :deep(.verdict-panel) {
  border-color: rgba(255, 255, 255, 0.13);
  background: rgba(255, 255, 255, 0.035);
  box-shadow: 0 22px 68px rgba(2, 6, 23, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

.debate-stage :deep(.arena-hero) {
  justify-self: center;
  width: min(1180px, 100%);
  padding: 14px 18px;
  border-radius: 26px;
}

.debate-stage :deep(.arena-status) {
  justify-self: center;
  width: min(1180px, 100%);
  margin-bottom: 2px;
}

.debate-stage :deep(.agent-grid) {
  width: min(1380px, 100%);
  gap: clamp(14px, 2vw, 24px);
}

.debate-stage :deep(.agent-card) {
  min-height: clamp(320px, 42vh, 500px);
  background: rgba(255, 255, 255, 0.045);
}

.debate-stage :deep(.verdict-panel) {
  width: min(1020px, 100%);
  margin-bottom: clamp(18px, 2.6vh, 42px);
}

.debate-stage :deep(.arena-hero h1),
.debate-stage :deep(.agent-header h2),
.debate-stage :deep(.scenario-drilldown-heading h3),
.debate-stage :deep(.verdict-copy h2) {
  color: rgba(248, 250, 252, 0.94);
  text-shadow: 0 1px 18px rgba(2, 6, 23, 0.42);
}

.debate-stage :deep(.arena-hero p),
.debate-stage :deep(.scenario-drilldown-heading p),
.debate-stage :deep(.verdict-copy p),
.debate-stage :deep(.agent-header p) {
  color: rgba(191, 219, 254, 0.82);
}

.debate-stage :deep(.arena-hero span),
.debate-stage :deep(.arena-status p),
.debate-stage :deep(.agent-content),
.debate-stage :deep(.agent-reasoning-list li),
.debate-stage :deep(.agent-points span),
.debate-stage :deep(.scenario-drilldown-heading span),
.debate-stage :deep(.scenario-drilldown-point p),
.debate-stage :deep(.verdict-copy span),
.debate-stage :deep(.verdict-scenario-card p),
.debate-stage :deep(.verdict-scenario-card small) {
  color: rgba(226, 232, 240, 0.76);
}

.debate-stage :deep(.agent-stats article),
.debate-stage :deep(.verdict-metrics article),
.debate-stage :deep(.agent-content),
.debate-stage :deep(.agent-points span),
.debate-stage :deep(.scenario-drilldown-point),
.debate-stage :deep(.verdict-scenario-card) {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(15, 23, 42, 0.3);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.debate-stage :deep(.agent-stats span),
.debate-stage :deep(.verdict-metrics span),
.debate-stage :deep(.scenario-drilldown-point span),
.debate-stage :deep(.verdict-scenario-card span) {
  color: rgba(203, 213, 225, 0.58);
}

.debate-stage :deep(.agent-stats strong),
.debate-stage :deep(.verdict-metrics strong),
.debate-stage :deep(.scenario-drilldown-point strong),
.debate-stage :deep(.verdict-scenario-card strong) {
  color: rgba(248, 250, 252, 0.92);
}

.debate-stage :deep(.agent-content::after) {
  background: linear-gradient(to bottom, rgba(15, 23, 42, 0), rgba(15, 23, 42, 0.74));
}

.debate-stage :deep(.reasoning-highlight.macro) {
  color: #a5b4fc;
}

.debate-stage :deep(.reasoning-highlight.bull) {
  color: #6ee7b7;
}

.debate-stage :deep(.reasoning-highlight.bear) {
  color: #fda4af;
}

@media (max-width: 900px) {
  .mirofish-app-entry {
    padding: 0;
  }

  .mirofish-app-hero {
    grid-template-columns: minmax(0, 1fr);
    width: calc(100% - 24px);
    border-radius: 26px;
  }

  .view-mode-rail {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .mirofish-app-meta {
    justify-items: start;
  }

  .mirofish-app-meta > div {
    justify-content: flex-start;
  }

  .mirofish-live-chart {
    top: 172px;
    right: 12px;
    bottom: 14px;
    left: 12px;
    width: auto;
  }

  .focus-sync-rail {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .debate-stage :deep(.arena-hero) {
    padding: 14px;
  }

  .cosmic-canvas-stage :deep(.cosmic-data-pill) {
    top: 128px;
    left: 14px;
  }
}
</style>
