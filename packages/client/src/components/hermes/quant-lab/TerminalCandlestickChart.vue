<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts'
import { useTerminalActions } from '@/composables/useTerminalActions'
import type {
  CandlestickData,
  HistogramData,
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'

interface CandleInput {
  time?: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const props = defineProps<{
  symbol: string
  action: string
  score: number | string
  price: number | null
  candles: CandleInput[]
}>()

const containerRef = ref<HTMLElement | null>(null)
const { latestAction } = useTerminalActions()

let chart: IChartApi | null = null
let candleSeries: ISeriesApi<'Candlestick'> | null = null
let volumeSeries: ISeriesApi<'Histogram'> | null = null
let markerApi: ISeriesMarkersPluginApi<Time> | null = null
let resizeObserver: ResizeObserver | null = null
let actionPriceLines: any[] = []

function normalizeTime(index: number): UTCTimestamp {
  const firstTime = Math.floor(Date.now() / 1000) - Math.max(props.candles.length - 1, 0) * 900
  return (props.candles[index]?.time ?? firstTime + index * 900) as UTCTimestamp
}

function candleData(): CandlestickData[] {
  return props.candles.map((bar, index) => ({
    time: normalizeTime(index),
    open: Number(bar.open.toFixed(2)),
    high: Number(bar.high.toFixed(2)),
    low: Number(bar.low.toFixed(2)),
    close: Number(bar.close.toFixed(2)),
  }))
}

function volumeData(): HistogramData[] {
  return props.candles.map((bar, index) => ({
    time: normalizeTime(index),
    value: Math.max(0, Math.round(bar.volume)),
    color: bar.close >= bar.open ? 'rgba(0, 255, 0, 0.42)' : 'rgba(255, 0, 60, 0.42)',
  }))
}

function markerData(candles: CandlestickData[]): SeriesMarker<Time>[] {
  const last = candles.at(-1)
  if (!last) return []

  const action = props.action || 'WATCH'
  const isBuy = action === 'BUY'
  const isSell = action === 'SELL'
  const color = isBuy ? '#00ff00' : isSell ? '#ff003c' : '#ffd700'
  const actionLabel = action === 'BUY'
    ? '買入'
    : action === 'SELL'
      ? '賣出'
      : action === 'HOLD'
        ? '持有'
        : '觀察'

  return [
    {
      time: last.time,
      position: isSell ? 'aboveBar' : 'belowBar',
      color,
      shape: isBuy ? 'arrowUp' : isSell ? 'arrowDown' : 'circle',
      text: `${props.symbol} ${actionLabel} ${props.score}`,
    },
  ]
}

function resizeChart() {
  const el = containerRef.value
  if (!chart || !el) return

  const rect = el.getBoundingClientRect()
  chart.resize(Math.max(240, Math.floor(rect.width)), Math.max(150, Math.floor(rect.height)))
}

function updateChart() {
  if (!candleSeries || !volumeSeries) return

  const candles = candleData()
  candleSeries.setData(candles)
  volumeSeries.setData(volumeData())
  markerApi?.setMarkers(markerData(candles))
  chart?.timeScale().fitContent()
}

function clearActionPriceLines() {
  if (candleSeries) {
    for (const line of actionPriceLines) {
      candleSeries.removePriceLine(line)
    }
  }
  actionPriceLines = []
}

function drawActionPriceLine(payload: Record<string, unknown>) {
  if (!candleSeries) return

  const ticker = typeof payload.ticker === 'string' ? payload.ticker.trim().toUpperCase() : ''
  if (ticker && ticker !== props.symbol.toUpperCase()) return

  const rawPrice = payload.price ?? payload.level ?? payload.stop
  const price = typeof rawPrice === 'number' ? rawPrice : Number(rawPrice)
  if (!Number.isFinite(price) || price <= 0) return

  const color = typeof payload.color === 'string' ? payload.color : '#ff003c'
  const title = typeof payload.title === 'string'
    ? payload.title
    : typeof payload.label === 'string'
      ? payload.label
      : `AI LINE ${price.toFixed(2)}`

  const priceLine = candleSeries.createPriceLine({
    price,
    color,
    lineWidth: 2,
    lineStyle: 2,
    axisLabelVisible: true,
    title,
  } as any)
  actionPriceLines.push(priceLine)

  if (actionPriceLines.length > 6) {
    const oldest = actionPriceLines.shift()
    if (oldest) candleSeries.removePriceLine(oldest)
  }
}

function mountChart() {
  const el = containerRef.value
  if (!el || chart) return

  const rect = el.getBoundingClientRect()
  chart = createChart(el, {
    width: Math.max(240, Math.floor(rect.width)),
    height: Math.max(150, Math.floor(rect.height)),
    layout: {
      background: { type: ColorType.Solid, color: '#010101' },
      textColor: '#7f8b98',
      fontFamily: '"JetBrains Mono", "Fira Code", "Roboto Mono", ui-monospace, monospace',
    },
    grid: {
      vertLines: { color: '#18212c' },
      horzLines: { color: '#18212c' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#ffd70066', width: 1, style: 3, labelBackgroundColor: '#111' },
      horzLine: { color: '#ffd70066', width: 1, style: 3, labelBackgroundColor: '#111' },
    },
    rightPriceScale: {
      borderColor: '#333',
      scaleMargins: { top: 0.08, bottom: 0.24 },
    },
    timeScale: {
      borderColor: '#333',
      timeVisible: true,
      secondsVisible: false,
    },
  })

  const nextCandleSeries = chart.addSeries(CandlestickSeries, {
    upColor: '#00ff00',
    downColor: '#ff003c',
    borderUpColor: '#00ff00',
    borderDownColor: '#ff003c',
    wickUpColor: '#00ff00',
    wickDownColor: '#ff003c',
    priceLineColor: '#ffd700',
    lastValueVisible: true,
    priceFormat: {
      type: 'custom',
      formatter: (price: number) => `$${price.toFixed(2)}`,
      minMove: 0.01,
    },
  })
  candleSeries = nextCandleSeries

  const nextVolumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
    lastValueVisible: false,
    priceLineVisible: false,
  })
  volumeSeries = nextVolumeSeries
  chart.priceScale('volume').applyOptions({
    visible: false,
    scaleMargins: { top: 0.78, bottom: 0 },
  })

  markerApi = createSeriesMarkers(nextCandleSeries)
  updateChart()

  resizeObserver = new ResizeObserver(resizeChart)
  resizeObserver.observe(el)
}

onMounted(() => {
  void nextTick(mountChart)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  clearActionPriceLines()
  chart?.remove()
  chart = null
  candleSeries = null
  volumeSeries = null
  markerApi = null
})

watch(
  () => [props.candles, props.symbol, props.action, props.score, props.price],
  updateChart,
  { deep: true },
)

watch(
  () => props.symbol,
  () => {
    clearActionPriceLines()
  },
)

watch(latestAction, (action) => {
  if (action?.type === 'DRAW_LINE') {
    drawActionPriceLine(action.payload)
  }
})
</script>

<template>
  <div ref="containerRef" class="terminal-candlestick-chart" />
</template>

<style scoped lang="scss">
.terminal-candlestick-chart {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #010101;
}
</style>
