<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  value: number
  compact?: boolean
}>(), {
  compact: true,
})

const moneyRef = ref<HTMLElement | null>(null)
let previousValue = props.value

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (props.compact && abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (props.compact && abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(2)}`
}

function paintValue(value: number) {
  const el = moneyRef.value
  if (!el) return

  el.textContent = formatMoney(value)
  if (value > previousValue) {
    el.style.color = '#00ff00'
    el.style.textShadow = '0 0 18px rgba(0, 255, 0, 0.7)'
  } else if (value < previousValue) {
    el.style.color = '#ff003c'
    el.style.textShadow = '0 0 18px rgba(255, 0, 60, 0.72)'
  }
  previousValue = value
}

onMounted(() => {
  paintValue(props.value)
})

watch(() => props.value, paintValue, { flush: 'post' })
</script>

<template>
  <span ref="moneyRef" class="fast-money-text" />
</template>

<style scoped lang="scss">
.fast-money-text {
  display: inline-block;
  font-family: "JetBrains Mono", "Fira Code", "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  transition: color 0.08s ease-out, text-shadow 0.08s ease-out;
}
</style>
