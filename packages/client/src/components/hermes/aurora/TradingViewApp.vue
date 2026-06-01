<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { auroraEventBus, type AuroraTickerFocusedPayload } from '@/services/hermes/aurora/aurora-event-bus'
import { normalizeTradingViewSymbol } from '@/services/hermes/aurora/intent-parsers'

const props = withDefaults(defineProps<{
  symbol?: string
  source?: string
}>(), {
  symbol: 'NASDAQ:NVDA',
  source: 'aurora-app-window',
})

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => unknown
    }
  }
}

type TradingViewChartApi = {
  setSymbol?: (symbol: string, interval?: string, callback?: () => void) => void
}

type TradingViewWidgetInstance = {
  activeChart?: () => TradingViewChartApi
  onChartReady?: (callback: () => void) => void
  remove?: () => void
}

const EXTERNAL_OPEN_TIMEOUT_MS = 1200

const containerId = `aurora_tradingview_${Math.random().toString(36).slice(2)}`
const containerRef = ref<HTMLElement | null>(null)
const activeSymbol = ref(normalizeTradingViewSymbol(props.symbol) || 'NASDAQ:NVDA')
const isLoading = ref(true)
const errorMessage = ref('')
const isChartReady = ref(false)
const externalOpenNotice = ref('')
const copiedTradingViewLink = ref(false)
let scriptPromise: Promise<void> | null = null
let widgetInstance: TradingViewWidgetInstance | null = null
let unsubscribeTickerFocus: (() => void) | null = null

const externalChartUrl = computed(() =>
  `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(activeSymbol.value)}`,
)
const preferredTradingViewUrl = computed(() => externalChartUrl.value)

function destroyWidget() {
  widgetInstance?.remove?.()
  widgetInstance = null
  if (containerRef.value) containerRef.value.innerHTML = ''
}

async function openTradingViewWithSystemBrowser(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), EXTERNAL_OPEN_TIMEOUT_MS)
  try {
    const response = await fetch('/api/aurora/open-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    return response.ok && Boolean(payload?.ok)
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

function openPendingTradingViewWindow(): Window | null {
  const opened = window.open('about:blank', 'aurora_tradingview_login')
  if (!opened) return null
  try {
    opened.document?.write?.('<title>Opening TradingView...</title>')
    opened.opener = null
  } catch {
    // Some browsers restrict about:blank handles immediately; navigation can still proceed below.
  }
  return opened
}

async function openTradingViewUrl(url: string, systemSuccessMessage: string) {
  externalOpenNotice.value = ''
  copiedTradingViewLink.value = false
  const pendingWindow = openPendingTradingViewWindow()

  if (await openTradingViewWithSystemBrowser(url)) {
    pendingWindow?.close?.()
    externalOpenNotice.value = systemSuccessMessage
    return
  }

  if (pendingWindow) {
    pendingWindow.location.href = url
    pendingWindow.focus?.()
    window.setTimeout(() => {
      externalOpenNotice.value = '已開啟 TradingView 視窗；若沒有看到，請複製連結到 Safari 或 Chrome。'
    }, 300)
    return
  }

  externalOpenNotice.value = '這個瀏覽器阻擋了外部視窗，已改用目前視窗開啟 TradingView。'
  window.location.assign(url)
}

async function openTradingView() {
  if (typeof window === 'undefined') return
  await openTradingViewUrl(
    preferredTradingViewUrl.value,
    '已用系統瀏覽器開啟 TradingView 圖表。',
  )
}

function openTradingViewInCurrentTab() {
  if (typeof window === 'undefined') return
  window.location.assign(preferredTradingViewUrl.value)
}

async function copyTradingViewUrl() {
  if (typeof navigator === 'undefined') return
  try {
    await navigator.clipboard?.writeText(preferredTradingViewUrl.value)
    copiedTradingViewLink.value = true
    externalOpenNotice.value = 'TradingView 連結已複製。'
  } catch {
    externalOpenNotice.value = externalChartUrl.value
  }
}

function loadTradingViewScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.TradingView?.widget) return Promise.resolve()
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-aurora-tradingview="true"]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('TradingView script failed to load.')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/tv.js'
    script.async = true
    script.dataset.auroraTradingview = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('TradingView script failed to load.'))
    document.head.appendChild(script)
  })

  return scriptPromise
}

function setWidgetSymbol(nextSymbol: string): boolean {
  const chart = widgetInstance?.activeChart?.()
  if (!chart?.setSymbol) return false
  try {
    chart.setSymbol(nextSymbol, '15')
    return true
  } catch {
    return false
  }
}

async function renderWidget() {
  if (typeof window === 'undefined') return
  isLoading.value = true
  errorMessage.value = ''
  isChartReady.value = false

  try {
    await loadTradingViewScript()
    await nextTick()
    if (!containerRef.value || !window.TradingView?.widget) {
      throw new Error('TradingView runtime is unavailable.')
    }

    destroyWidget()
    widgetInstance = new window.TradingView.widget({
      autosize: true,
      symbol: activeSymbol.value,
      interval: '15',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      toolbar_bg: 'transparent',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      details: true,
      hotlist: true,
      calendar: true,
      withdateranges: true,
      backgroundColor: 'rgba(0,0,0,0)',
      gridColor: 'rgba(255,255,255,0.05)',
      studies: ['STD;Volume'],
      container_id: containerId,
    }) as TradingViewWidgetInstance

    widgetInstance.onChartReady?.(() => {
      isChartReady.value = true
      isLoading.value = false
    })

    window.setTimeout(() => {
      if (widgetInstance && !isChartReady.value) {
        isChartReady.value = true
        isLoading.value = false
      }
    }, 1600)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'TradingView is unavailable in this environment.'
    isLoading.value = false
  }
}

function handleTickerChange(payload: AuroraTickerFocusedPayload) {
  const nextSymbol = normalizeTradingViewSymbol(payload.symbol || payload.rawSymbol || '')
  if (!nextSymbol || nextSymbol === activeSymbol.value) return
  activeSymbol.value = nextSymbol
  if (!setWidgetSymbol(nextSymbol)) {
    void renderWidget()
  }
}

watch(() => props.symbol, (nextSymbol) => {
  const normalized = normalizeTradingViewSymbol(nextSymbol || '')
  if (!normalized || normalized === activeSymbol.value) return
  activeSymbol.value = normalized
  if (!setWidgetSymbol(normalized)) {
    void renderWidget()
  }
})

onMounted(() => {
  unsubscribeTickerFocus = auroraEventBus.on('TICKER_FOCUSED', handleTickerChange)
  void renderWidget()
})

onBeforeUnmount(() => {
  unsubscribeTickerFocus?.()
  unsubscribeTickerFocus = null
  destroyWidget()
})
</script>

<template>
  <section class="tradingview-app" aria-label="Aurora TradingView App">
    <header class="tradingview-app-header">
      <div>
        <p>Neural Market Engine</p>
        <h1>TradingView</h1>
      </div>
      <div class="tradingview-lite-pill" aria-label="TradingView Lite AI Sync mode">
        <span>Lite</span>
        <small>AI Sync</small>
      </div>
      <div class="tradingview-app-symbol">
        <span :class="{ ready: isChartReady && !errorMessage }"></span>
        <strong>{{ activeSymbol }}</strong>
      </div>
      <button type="button" class="tradingview-external-button" @click="openTradingView">Open TradingView</button>
    </header>

    <main class="tradingview-app-shell">
      <div
        :id="containerId"
        ref="containerRef"
        class="tradingview-widget-host"
        aria-label="TradingView Lite widget"
      ></div>
      <aside v-if="externalOpenNotice" class="tradingview-open-notice" aria-live="polite">
        <span>{{ externalOpenNotice }}</span>
        <div>
          <button type="button" @click="openTradingViewInCurrentTab">目前視窗開啟</button>
          <button type="button" @click="copyTradingViewUrl">
            {{ copiedTradingViewLink ? '已複製' : '複製連結' }}
          </button>
        </div>
      </aside>
      <div v-if="isLoading || errorMessage" class="tradingview-app-state">
        <strong>{{ isLoading ? 'Hydrating live chart' : 'Chart fallback' }}</strong>
        <span v-if="isLoading">Synchronizing {{ activeSymbol }} through the Aurora Event Bus.</span>
        <span v-else>{{ errorMessage }}</span>
      </div>
    </main>
  </section>
</template>

<style scoped lang="scss">
.tradingview-app {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: rgba(248, 250, 252, 0.94);
  background:
    radial-gradient(860px 540px at 18% 12%, rgba(99, 102, 241, 0.2), transparent 68%),
    radial-gradient(760px 520px at 84% 18%, rgba(56, 189, 248, 0.14), transparent 72%),
    linear-gradient(135deg, rgba(2, 6, 23, 0.7), rgba(15, 23, 42, 0.42));
}

.tradingview-app::before {
  position: absolute;
  inset: 0;
  pointer-events: none;
  content: "";
  background:
    linear-gradient(120deg, transparent 16%, rgba(255, 255, 255, 0.06) 32%, transparent 48%),
    radial-gradient(circle at 50% 100%, rgba(139, 92, 246, 0.16), transparent 54%);
  opacity: 0.9;
}

.tradingview-app-header,
.tradingview-app-shell {
  position: relative;
  z-index: 1;
}

.tradingview-app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-width: 0;
  margin: 18px;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 24px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.03)),
    rgba(0, 0, 0, 0.2);
  box-shadow: 0 24px 80px rgba(2, 6, 23, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
}

.tradingview-app-header p {
  margin: 0 0 4px;
  color: rgba(191, 219, 254, 0.74);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.16em;
  line-height: 1;
  text-transform: uppercase;
}

.tradingview-app-header h1 {
  margin: 0;
  color: #fff;
  font-size: 24px;
  font-weight: 950;
  letter-spacing: 0;
  line-height: 1;
}

.tradingview-external-button {
  flex: 0 0 auto;
  display: inline-grid;
  min-height: 36px;
  place-items: center;
  padding: 0 14px;
  border: 1px solid rgba(129, 140, 248, 0.42);
  border-radius: 999px;
  color: rgba(199, 210, 254, 0.96);
  background: rgba(99, 102, 241, 0.14);
  cursor: pointer;
  font-size: 12px;
  font-weight: 850;
  font-family: inherit;
  text-decoration: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.tradingview-external-button:hover {
  border-color: rgba(165, 180, 252, 0.66);
  color: #fff;
  background: rgba(99, 102, 241, 0.24);
  box-shadow: 0 12px 32px rgba(99, 102, 241, 0.2);
}

.tradingview-lite-pill {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  color: rgba(238, 242, 255, 0.98);
  background:
    radial-gradient(circle at 50% 0%, rgba(165, 180, 252, 0.22), transparent 70%),
    rgba(99, 102, 241, 0.13);
  box-shadow: 0 10px 30px rgba(99, 102, 241, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  font-size: 12px;
  font-weight: 900;
}

.tradingview-lite-pill small {
  color: rgba(199, 210, 254, 0.82);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0;
}

.tradingview-app-symbol {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 9px;
  padding: 9px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(226, 232, 240, 0.94);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
}

.tradingview-app-symbol span {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.86);
  box-shadow: 0 0 16px rgba(148, 163, 184, 0.28);
}

.tradingview-app-symbol span.ready {
  background: #34d399;
  box-shadow: 0 0 18px rgba(52, 211, 153, 0.52);
}

.tradingview-app-shell {
  min-height: 0;
  margin: 0 18px 18px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 28px;
  background:
    radial-gradient(520px 360px at 15% 0%, rgba(56, 189, 248, 0.1), transparent 70%),
    rgba(0, 0, 0, 0.2);
  box-shadow: 0 28px 90px rgba(2, 6, 23, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
}

.tradingview-widget-host {
  width: 100%;
  height: 100%;
  min-height: 520px;
}

.tradingview-open-notice {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 2;
  display: grid;
  gap: 10px;
  width: min(430px, calc(100% - 48px));
  padding: 18px;
  border: 1px solid rgba(129, 140, 248, 0.2);
  border-radius: 24px;
  color: rgba(226, 232, 240, 0.9);
  background:
    radial-gradient(circle at 0% 0%, rgba(99, 102, 241, 0.16), transparent 62%),
    rgba(2, 6, 23, 0.68);
  box-shadow: 0 24px 80px rgba(2, 6, 23, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
}

.tradingview-open-notice span {
  color: rgba(203, 213, 225, 0.76);
  font-size: 12px;
  line-height: 1.55;
}

.tradingview-open-notice div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tradingview-open-notice button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(129, 140, 248, 0.32);
  border-radius: 999px;
  color: rgba(224, 231, 255, 0.94);
  background: rgba(99, 102, 241, 0.14);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 850;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.tradingview-open-notice button:hover {
  border-color: rgba(165, 180, 252, 0.62);
  background: rgba(99, 102, 241, 0.24);
}

.tradingview-app-state {
  position: absolute;
  inset: 50% auto auto 50%;
  display: grid;
  gap: 8px;
  width: min(360px, calc(100% - 48px));
  padding: 18px;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 22px;
  background: rgba(2, 6, 23, 0.72);
  box-shadow: 0 24px 70px rgba(2, 6, 23, 0.42);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

.tradingview-app-state strong {
  color: #fff;
  font-size: 15px;
  font-weight: 900;
}

.tradingview-app-state span {
  color: rgba(203, 213, 225, 0.76);
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 760px) {
  .tradingview-app-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .tradingview-lite-pill {
    width: 100%;
  }

  .tradingview-external-button {
    width: 100%;
  }

  .tradingview-open-notice {
    right: 16px;
    bottom: 16px;
    width: calc(100% - 32px);
  }
}
</style>
