<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  symbol?: string
}>(), {
  symbol: 'NVDA',
})

const emit = defineEmits<{
  close: []
}>()

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => unknown
    }
  }
}

const containerId = `tradingview_${Math.random().toString(36).slice(2)}`
const containerRef = ref<HTMLElement | null>(null)
const isLoading = ref(true)
const errorMessage = ref('')
let scriptPromise: Promise<void> | null = null

function normalizeTradingViewSymbol(value: string): string {
  const clean = String(value || '').trim().toUpperCase().replace(/^\$/, '')
  if (!clean) return 'NASDAQ:NVDA'
  if (clean.includes(':')) return clean
  if (/^(BTC|ETH|SOL|XRP|DOGE)-?USD$/.test(clean)) {
    return `COINBASE:${clean.replace('-', '')}`
  }
  return `NASDAQ:${clean}`
}

const tradingViewSymbol = computed(() => normalizeTradingViewSymbol(props.symbol))
const externalChartUrl = computed(() =>
  `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tradingViewSymbol.value)}`,
)

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

async function renderWidget() {
  if (typeof window === 'undefined') return
  isLoading.value = true
  errorMessage.value = ''

  try {
    await loadTradingViewScript()
    await nextTick()
    if (!containerRef.value || !window.TradingView?.widget) {
      throw new Error('TradingView runtime is unavailable.')
    }

    containerRef.value.innerHTML = ''
    new window.TradingView.widget({
      autosize: true,
      symbol: tradingViewSymbol.value,
      interval: '15',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      toolbar_bg: 'rgba(0,0,0,0)',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      details: true,
      hotlist: true,
      calendar: true,
      withdateranges: true,
      backgroundColor: 'rgba(0,0,0,0)',
      gridColor: 'rgba(255,255,255,0.06)',
      studies: ['STD;Volume'],
      container_id: containerId,
    })
  } catch (error: any) {
    errorMessage.value = error?.message || 'TradingView is unavailable in this environment.'
  } finally {
    isLoading.value = false
  }
}

watch(tradingViewSymbol, () => {
  void renderWidget()
})

onMounted(() => {
  void renderWidget()
})

onBeforeUnmount(() => {
  if (containerRef.value) containerRef.value.innerHTML = ''
})
</script>

<template>
  <aside class="tradingview-panel" aria-label="TradingView live chart">
    <header class="tradingview-panel-header">
      <div>
        <span>Live Chart</span>
        <strong>{{ tradingViewSymbol }}</strong>
      </div>
      <div class="tradingview-panel-actions">
        <a :href="externalChartUrl" target="_blank" rel="noreferrer">Open</a>
        <button type="button" aria-label="Close Live Chart" @click="emit('close')">Close</button>
      </div>
    </header>

    <div class="tradingview-frame-shell">
      <div :id="containerId" ref="containerRef" class="tradingview-widget-host"></div>
      <div v-if="isLoading || errorMessage" class="tradingview-state-card">
        <strong>{{ isLoading ? 'Loading market data' : 'Chart fallback' }}</strong>
        <span v-if="isLoading">Syncing {{ tradingViewSymbol }} through TradingView.</span>
        <span v-else>{{ errorMessage }}</span>
      </div>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.tradingview-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 28px;
  color: rgba(248, 250, 252, 0.94);
  background:
    radial-gradient(420px 320px at 20% 0%, rgba(99, 102, 241, 0.18), transparent 70%),
    rgba(2, 6, 23, 0.42);
  box-shadow: 0 28px 90px rgba(2, 6, 23, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
}

.tradingview-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-width: 0;
  padding: 14px 14px 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}

.tradingview-panel-header div:first-child {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.tradingview-panel-header span {
  color: rgba(191, 219, 254, 0.72);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.1em;
  line-height: 1;
  text-transform: uppercase;
}

.tradingview-panel-header strong {
  overflow: hidden;
  color: #fff;
  font-size: 18px;
  font-weight: 950;
  letter-spacing: 0;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tradingview-panel-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.tradingview-panel-actions a,
.tradingview-panel-actions button {
  display: inline-grid;
  min-height: 30px;
  place-items: center;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  color: rgba(226, 232, 240, 0.86);
  background: rgba(255, 255, 255, 0.07);
  cursor: pointer;
  font-size: 11px;
  font-weight: 850;
  text-decoration: none;
  transition: all 0.24s cubic-bezier(0.4, 0, 0.2, 1);
}

.tradingview-panel-actions a:hover,
.tradingview-panel-actions button:hover,
.tradingview-panel-actions a:focus-visible,
.tradingview-panel-actions button:focus-visible {
  border-color: rgba(129, 140, 248, 0.38);
  color: #fff;
  background: rgba(129, 140, 248, 0.18);
  outline: none;
  transform: translateY(-1px);
}

.tradingview-frame-shell {
  position: relative;
  min-width: 0;
  min-height: 0;
  padding: 10px;
}

.tradingview-widget-host {
  width: 100%;
  height: 100%;
  min-height: 360px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  background: rgba(2, 6, 23, 0.24);
}

.tradingview-state-card {
  position: absolute;
  inset: 50% auto auto 50%;
  display: grid;
  width: min(260px, calc(100% - 44px));
  gap: 8px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  color: rgba(226, 232, 240, 0.82);
  background: rgba(15, 23, 42, 0.66);
  box-shadow: 0 22px 64px rgba(2, 6, 23, 0.34);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  text-align: center;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.tradingview-state-card strong {
  color: rgba(248, 250, 252, 0.94);
  font-size: 13px;
  font-weight: 900;
  line-height: 1.2;
}

.tradingview-state-card span {
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
}
</style>
