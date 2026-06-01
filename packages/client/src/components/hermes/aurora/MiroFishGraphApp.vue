<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fetchSystemStatus } from '@/api/hermes/system-status'

const DEFAULT_MIROFISH_URL = 'http://localhost:3000'
const DEFAULT_PROJECT_ID = 'preview-project'
const FRAME_TIMEOUT_MS = 8000

interface MiroFishGraphAppProps {
  initialUrl?: string
  projectId?: string
  graphPath?: string
}

const props = withDefaults(defineProps<MiroFishGraphAppProps>(), {
  initialUrl: '',
  projectId: DEFAULT_PROJECT_ID,
  graphPath: '',
})

const baseUrl = ref(props.initialUrl || import.meta.env.VITE_MIROFISH_FRONTEND_URL || DEFAULT_MIROFISH_URL)
const statusText = ref('Checking MiroFish graph service...')
const statusKind = ref<'checking' | 'ready' | 'warn' | 'error'>('checking')
const frameKey = ref(0)
const frameLoaded = ref(false)
const frameTimedOut = ref(false)
let frameTimer: number | undefined

const graphUrl = computed(() => {
  const cleanBase = String(baseUrl.value || DEFAULT_MIROFISH_URL).replace(/\/+$/, '')
  if (props.graphPath) {
    const cleanPath = props.graphPath.startsWith('/') ? props.graphPath : `/${props.graphPath}`
    return `${cleanBase}${cleanPath}`
  }
  return `${cleanBase}/process/${encodeURIComponent(props.projectId || DEFAULT_PROJECT_ID)}`
})

const serviceHint = computed(() => {
  if (statusKind.value === 'ready' && !frameTimedOut.value) return ''
  if (frameTimedOut.value) return 'The embedded graph has not responded yet. Reload, open externally, or start the MiroFish frontend service.'
  if (statusKind.value === 'warn') return 'MiroFish frontend is not reachable. The graph window is ready, but the service may need to be started.'
  if (statusKind.value === 'error') return 'Aurora could not check MiroFish status. You can still try opening the graph externally.'
  return ''
})

function clearFrameTimer(): void {
  if (!frameTimer) return
  window.clearTimeout(frameTimer)
  frameTimer = undefined
}

function startFrameTimer(): void {
  clearFrameTimer()
  frameTimedOut.value = false
  frameTimer = window.setTimeout(() => {
    if (frameLoaded.value) return
    frameTimedOut.value = true
  }, FRAME_TIMEOUT_MS)
}

async function refreshStatus(): Promise<void> {
  statusKind.value = 'checking'
  statusText.value = 'Checking MiroFish graph service...'
  try {
    const status = await fetchSystemStatus()
    const frontend = status.components.find(component => component.key === 'mirofish-frontend')
    if (!props.initialUrl && frontend?.url) baseUrl.value = String(frontend.url)
    if (frontend?.status === 'ok') {
      statusKind.value = 'ready'
      statusText.value = 'MiroFish graph UI is reachable.'
    } else {
      statusKind.value = 'warn'
      statusText.value = frontend?.summary || 'MiroFish graph UI is not reachable yet.'
    }
  } catch (err: any) {
    statusKind.value = 'error'
    statusText.value = err?.message || 'Unable to check MiroFish status.'
  }
}

function reloadGraph(): void {
  frameLoaded.value = false
  startFrameTimer()
  frameKey.value += 1
  void refreshStatus()
}

function handleFrameLoad(): void {
  frameLoaded.value = true
  frameTimedOut.value = false
  clearFrameTimer()
}

function openExternal(): void {
  window.open(graphUrl.value, '_blank', 'noopener,noreferrer')
}

onMounted(() => {
  startFrameTimer()
  void refreshStatus()
})

onUnmounted(() => {
  clearFrameTimer()
})
</script>

<template>
  <section class="mirofish-graph-app" aria-label="MiroFish Graph App">
    <div class="cosmic-glow one"></div>
    <div class="cosmic-glow two"></div>

    <header class="graph-toolbar">
      <div>
        <p>MiroFish Knowledge Graph</p>
        <h2>Graph Relationship Visualization</h2>
      </div>
      <div class="toolbar-actions">
        <span class="service-pill" :class="statusKind">
          <i></i>
          {{ statusText }}
        </span>
        <button type="button" @click="reloadGraph">Reload</button>
        <button type="button" @click="openExternal">Open External</button>
      </div>
    </header>

    <main class="graph-frame-shell">
      <aside v-if="serviceHint" class="service-advisory" :class="statusKind">
        <strong>{{ frameTimedOut ? 'Graph response timeout' : 'Service notice' }}</strong>
        <span>{{ serviceHint }}</span>
        <div>
          <button type="button" @click="reloadGraph">Try Reload</button>
          <button type="button" @click="openExternal">Open External</button>
        </div>
      </aside>
      <iframe
        :key="frameKey"
        class="graph-frame"
        :src="graphUrl"
        title="MiroFish Knowledge Graph"
        referrerpolicy="no-referrer"
        @load="handleFrameLoad"
      ></iframe>
      <div v-if="!frameLoaded" class="frame-loading">
        <span></span>
        {{ frameTimedOut ? 'Waiting for MiroFish graph service...' : 'Loading MiroFish graph...' }}
      </div>
    </main>
  </section>
</template>

<style scoped lang="scss">
.mirofish-graph-app {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 100%;
  overflow: hidden;
  color: rgba(248, 250, 252, 0.94);
  background:
    radial-gradient(circle at 50% 35%, rgba(79, 70, 229, 0.26), transparent 38%),
    radial-gradient(circle at 15% 12%, rgba(56, 189, 248, 0.18), transparent 32%),
    radial-gradient(circle at 86% 82%, rgba(236, 72, 153, 0.16), transparent 36%),
    linear-gradient(135deg, #0f172a 0%, #111827 45%, #1e1b4b 100%);
}

.cosmic-glow {
  position: absolute;
  width: 46vw;
  height: 46vw;
  pointer-events: none;
  border-radius: 999px;
  filter: blur(80px);
  opacity: 0.35;
}

.cosmic-glow.one {
  top: -20%;
  left: -8%;
  background: rgba(56, 189, 248, 0.35);
}

.cosmic-glow.two {
  right: -18%;
  bottom: -28%;
  background: rgba(168, 85, 247, 0.32);
}

.graph-toolbar {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin: 18px;
  padding: 14px 16px 14px 20px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.07);
  box-shadow: 0 18px 52px rgba(2, 6, 23, 0.24);
  backdrop-filter: blur(18px);
}

.graph-toolbar p {
  margin: 0 0 4px;
  color: rgba(191, 219, 254, 0.82);
  font-size: 11px;
  font-weight: 850;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.graph-toolbar h2 {
  margin: 0;
  color: #fff;
  font-size: clamp(18px, 2vw, 28px);
  letter-spacing: 0;
}

.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.service-pill,
.toolbar-actions button {
  min-height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(226, 232, 240, 0.92);
  font-size: 12px;
  font-weight: 760;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.service-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 360px;
  padding: 0 12px;
}

.service-pill i {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #94a3b8;
  box-shadow: 0 0 14px currentColor;
}

.service-pill.ready i {
  background: #34d399;
}

.service-pill.warn i,
.service-pill.checking i {
  background: #fbbf24;
}

.service-pill.error i {
  background: #fb7185;
}

.toolbar-actions button {
  padding: 0 13px;
  cursor: pointer;
}

.toolbar-actions button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.28);
  color: #fff;
  transform: translateY(-1px);
}

.toolbar-actions button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.graph-frame-shell {
  position: relative;
  z-index: 2;
  min-height: 0;
  margin: 0 18px 18px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 28px;
  background: rgba(15, 23, 42, 0.42);
  box-shadow: 0 24px 74px rgba(2, 6, 23, 0.34);
}

.service-advisory {
  position: absolute;
  top: 18px;
  right: 18px;
  z-index: 4;
  display: grid;
  gap: 8px;
  width: min(360px, calc(100% - 36px));
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 18px;
  background: rgba(15, 23, 42, 0.72);
  box-shadow: 0 18px 48px rgba(2, 6, 23, 0.34);
  backdrop-filter: blur(16px);
}

.service-advisory.warn {
  border-color: rgba(251, 191, 36, 0.32);
  box-shadow: 0 18px 48px rgba(251, 191, 36, 0.1);
}

.service-advisory.error {
  border-color: rgba(251, 113, 133, 0.32);
  box-shadow: 0 18px 48px rgba(251, 113, 133, 0.1);
}

.service-advisory strong {
  color: #fff;
  font-size: 13px;
}

.service-advisory span {
  color: rgba(226, 232, 240, 0.8);
  font-size: 12px;
  line-height: 1.45;
}

.service-advisory div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.service-advisory button {
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(248, 250, 252, 0.9);
  cursor: pointer;
  font-size: 12px;
  font-weight: 760;
}

.service-advisory button:hover {
  background: rgba(255, 255, 255, 0.16);
}

.graph-frame {
  width: 100%;
  height: 100%;
  min-height: 620px;
  border: 0;
  background: #0f172a;
}

.frame-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  gap: 12px;
  background: rgba(15, 23, 42, 0.72);
  color: rgba(226, 232, 240, 0.86);
  font-size: 13px;
  font-weight: 800;
  backdrop-filter: blur(12px);
}

.frame-loading span {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(255, 255, 255, 0.16);
  border-top-color: #93c5fd;
  border-radius: 999px;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 860px) {
  .graph-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .toolbar-actions {
    justify-content: flex-start;
  }

  .service-pill {
    max-width: 100%;
  }

  .service-advisory {
    top: 12px;
    right: 12px;
    width: calc(100% - 24px);
  }
}
</style>
