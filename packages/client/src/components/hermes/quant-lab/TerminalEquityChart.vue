<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AreaSeries, ColorType, CrosshairMode, createChart } from 'lightweight-charts'
import type { AreaData, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'

const props = defineProps<{
  values: number[]
}>()

const containerRef = ref<HTMLElement | null>(null)

let chart: IChartApi | null = null
let areaSeries: ISeriesApi<'Area'> | null = null
let resizeObserver: ResizeObserver | null = null

function equityData(): AreaData[] {
  if (!props.values.length) return []

  const startTime = Math.floor(Date.now() / 1000) - Math.max(props.values.length - 1, 0) * 86_400
  return props.values.map((value, index) => ({
    time: (startTime + index * 86_400) as UTCTimestamp,
    value: Number(value.toFixed(2)),
  }))
}

function resizeChart() {
  const el = containerRef.value
  if (!chart || !el) return

  const rect = el.getBoundingClientRect()
  chart.resize(Math.max(220, Math.floor(rect.width)), Math.max(120, Math.floor(rect.height)))
}

function updateChart() {
  if (!areaSeries) return

  areaSeries.setData(equityData())
  chart?.timeScale().fitContent()
}

function mountChart() {
  const el = containerRef.value
  if (!el || chart) return

  const rect = el.getBoundingClientRect()
  chart = createChart(el, {
    width: Math.max(220, Math.floor(rect.width)),
    height: Math.max(120, Math.floor(rect.height)),
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
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: '#333',
      timeVisible: false,
    },
    localization: {
      priceFormatter: (price: number) => `$${price.toFixed(2)}`,
    },
  })

  areaSeries = chart.addSeries(AreaSeries, {
    lineColor: '#00ff00',
    topColor: 'rgba(0, 255, 0, 0.48)',
    bottomColor: 'rgba(0, 255, 0, 0.02)',
    lineWidth: 3,
    priceLineColor: '#ffd700',
    lastValueVisible: true,
  })

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
  chart?.remove()
  chart = null
  areaSeries = null
})

watch(() => props.values, updateChart, { deep: true })
</script>

<template>
  <div ref="containerRef" class="terminal-equity-chart" />
</template>

<style scoped lang="scss">
.terminal-equity-chart {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #010101;
}
</style>
