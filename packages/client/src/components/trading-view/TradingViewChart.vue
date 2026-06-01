<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  symbol?: string
  interval?: string
}>(), {
  symbol: 'AAPL',
  interval: 'D',
})

defineExpose({
  refreshChart,
})

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => unknown
    }
  }
}

const chartId = `tradingview_chart_${Math.random().toString(36).slice(2)}`
const chartContainer = ref<HTMLElement | null>(null)
let widget: unknown = null
let scriptPromise: Promise<void> | null = null

function normalizeSymbol(value: string): string {
  const clean = String(value || '').trim().toUpperCase().replace(/^\$/, '')
  if (!clean) return 'NASDAQ:AAPL'
  if (clean.includes(':')) return clean
  return `NASDAQ:${clean}`
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

async function createWidget() {
  if (typeof window === 'undefined') return
  await loadTradingViewScript()
  await nextTick()
  if (!chartContainer.value || !window.TradingView?.widget) return

  disposeWidget()
  chartContainer.value.innerHTML = ''
  widget = new window.TradingView.widget({
    autosize: true,
    symbol: normalizeSymbol(props.symbol),
    interval: props.interval,
    timezone: 'Etc/UTC',
    theme: 'dark',
    style: '1',
    locale: 'zh_TW',
    toolbar_bg: 'rgba(0,0,0,0)',
    enable_publishing: false,
    hide_top_toolbar: false,
    hide_legend: false,
    hide_side_toolbar: false,
    save_image: false,
    allow_symbol_change: true,
    backgroundColor: 'rgba(0,0,0,0)',
    gridColor: 'rgba(255,255,255,0.06)',
    container_id: chartId,
  })
}

function refreshChart() {
  void createWidget()
}

function disposeWidget() {
  const disposable = widget as { remove?: () => void } | null
  disposable?.remove?.()
  widget = null
}

watch(
  () => [props.symbol, props.interval],
  () => refreshChart(),
)

onMounted(() => {
  refreshChart()
})

onUnmounted(() => {
  disposeWidget()
})
</script>

<template>
  <div class="tradingview-chart-host">
    <div :id="chartId" ref="chartContainer" class="tradingview-chart"></div>
  </div>
</template>

<style scoped>
.tradingview-chart-host,
.tradingview-chart {
  width: 100%;
  height: 100%;
  min-height: 420px;
}
</style>
