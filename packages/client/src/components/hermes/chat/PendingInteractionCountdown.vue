<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  formatPendingInteractionTime,
  pendingInteractionMonotonicNow,
  pendingInteractionRemainingMs,
} from '@/utils/pending-interaction'

const props = defineProps<{
  deadline: number
}>()

const { t } = useI18n()
const now = ref(pendingInteractionMonotonicNow())
let timer: ReturnType<typeof setInterval> | null = null

const remainingMs = computed(() => pendingInteractionRemainingMs(props.deadline, now.value))
const elapsed = computed(() => remainingMs.value <= 0)
const label = computed(() => elapsed.value
  ? t('chat.interactionCountdownElapsed')
  : t('chat.interactionCountdown', { time: formatPendingInteractionTime(remainingMs.value) }))

onMounted(() => {
  timer = setInterval(() => { now.value = pendingInteractionMonotonicNow() }, 250)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <span class="pending-interaction-countdown" :class="{ 'pending-interaction-countdown--elapsed': elapsed }">
    {{ label }}
  </span>
</template>

<style scoped>
.pending-interaction-countdown {
  margin-inline-start: auto;
  padding: 3px 7px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
  border-radius: 999px;
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.08);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
}

.pending-interaction-countdown--elapsed {
  border-color: rgba(var(--warning-rgb), 0.28);
  color: var(--warning-color, #d97706);
  background: rgba(var(--warning-rgb), 0.08);
}
</style>
