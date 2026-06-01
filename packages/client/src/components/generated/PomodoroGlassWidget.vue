<script setup lang="ts">
import { computed, ref } from 'vue'

const mode = ref<'Focus' | 'Break'>('Focus')
const minutes = ref(25)
const isRunning = ref(false)

const progress = computed(() => (mode.value === 'Focus' ? 72 : 38))
const buttonLabel = computed(() => (isRunning.value ? 'Pause focus' : 'Start focus'))

function toggleTimer() {
  isRunning.value = !isRunning.value
}

function switchMode(nextMode: 'Focus' | 'Break') {
  mode.value = nextMode
  minutes.value = nextMode === 'Focus' ? 25 : 5
  isRunning.value = false
}
</script>

<template>
  <section class="pomodoro-glass-widget" aria-label="Pomodoro Glass Widget">
    <header>
      <div>
        <p>Generated Widget</p>
        <h2>Pomodoro Focus</h2>
      </div>
      <span>{{ mode }}</span>
    </header>

    <div class="timer-orb" :style="{ '--progress': `${progress}%` }">
      <strong>{{ minutes }}:00</strong>
      <small>{{ isRunning ? 'Deep work active' : 'Ready when you are' }}</small>
    </div>

    <div class="mode-row" aria-label="Pomodoro modes">
      <button
        type="button"
        :class="{ active: mode === 'Focus' }"
        @click="switchMode('Focus')"
      >
        Focus
      </button>
      <button
        type="button"
        :class="{ active: mode === 'Break' }"
        @click="switchMode('Break')"
      >
        Break
      </button>
    </div>

    <button class="primary-action" type="button" @click="toggleTimer">
      {{ buttonLabel }}
    </button>
  </section>
</template>

<style scoped>
.pomodoro-glass-widget {
  display: grid;
  gap: 18px;
  min-width: 0;
  padding: 22px;
  border: 1px solid rgba(255, 255, 255, 0.56);
  border-radius: 24px;
  color: #172033;
  background:
    radial-gradient(circle at 20% 10%, rgba(129, 191, 255, 0.42), transparent 34%),
    radial-gradient(circle at 82% 8%, rgba(198, 137, 255, 0.34), transparent 30%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.76), rgba(255, 255, 255, 0.42));
  box-shadow:
    0 20px 52px rgba(80, 83, 132, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px);
}

.pomodoro-glass-widget header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.pomodoro-glass-widget p,
.timer-orb small {
  margin: 0;
  color: rgba(21, 32, 51, 0.52);
  font-size: 11px;
  font-weight: 800;
  line-height: 1.2;
  text-transform: uppercase;
}

.pomodoro-glass-widget h2 {
  margin: 5px 0 0;
  color: rgba(21, 32, 51, 0.88);
  font-size: 24px;
  font-weight: 950;
  letter-spacing: 0;
  line-height: 1.05;
}

.pomodoro-glass-widget header span {
  padding: 6px 10px;
  border: 1px solid rgba(121, 99, 255, 0.22);
  border-radius: 999px;
  color: #6250dd;
  background: rgba(121, 99, 255, 0.08);
  font-size: 11px;
  font-weight: 850;
}

.timer-orb {
  display: grid;
  place-items: center;
  gap: 8px;
  width: min(220px, 72vw);
  aspect-ratio: 1;
  justify-self: center;
  border-radius: 999px;
  background:
    radial-gradient(circle at center, rgba(255, 255, 255, 0.92) 0 54%, transparent 55%),
    conic-gradient(from 180deg, #7668ff var(--progress), rgba(121, 99, 255, 0.12) 0);
  box-shadow:
    0 18px 42px rgba(121, 99, 255, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.86);
}

.timer-orb strong {
  color: rgba(21, 32, 51, 0.9);
  font-size: 42px;
  font-weight: 950;
  letter-spacing: 0;
  line-height: 1;
}

.mode-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.mode-row button,
.primary-action {
  min-height: 42px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  cursor: pointer;
  font-weight: 850;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.mode-row button {
  color: rgba(21, 32, 51, 0.62);
  background: rgba(255, 255, 255, 0.48);
}

.mode-row button.active,
.mode-row button:hover {
  color: #5e50db;
  background: rgba(121, 99, 255, 0.1);
}

.primary-action {
  color: #fff;
  background: linear-gradient(135deg, #6b6dff, #9f63ff 58%, #c45cff);
  box-shadow: 0 14px 30px rgba(121, 99, 255, 0.22);
}

.primary-action:hover {
  transform: translateY(-1px);
}
</style>
