<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fetchQuantLabStatus, type QuantLabStatus } from '@/api/hermes/quant-lab'

const loading = ref(false)
const error = ref('')
const status = ref<QuantLabStatus | null>(null)

async function loadStatus() {
  loading.value = true
  error.value = ''

  try {
    status.value = await fetchQuantLabStatus()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load Quant Lab status'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadStatus()
})
</script>

<template>
  <main class="quant-lab-view">
    <section class="hero-card">
      <div>
        <p class="eyebrow">Hermes Quant Lab</p>
        <h1>Quant Lab</h1>
        <p class="subtitle">
          Foundation surface for future market research, signal ranking, and valuation workflows.
        </p>
      </div>
      <button class="refresh-button" :disabled="loading" @click="loadStatus">
        {{ loading ? 'Refreshing…' : 'Refresh status' }}
      </button>
    </section>

    <section class="status-card">
      <div class="status-header">
        <h2>Service status</h2>
        <span class="status-pill" :class="{ ready: status?.ok }">
          {{ status?.ok ? 'Ready' : loading ? 'Loading' : 'Unavailable' }}
        </span>
      </div>

      <p v-if="error" class="error-message">{{ error }}</p>
      <dl v-else class="status-grid">
        <div>
          <dt>Feature</dt>
          <dd>{{ status?.feature ?? 'quant-lab' }}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{{ status?.status ?? 'foundation' }}</dd>
        </div>
        <div>
          <dt>Capabilities</dt>
          <dd>{{ status?.capabilities?.join(', ') || 'status' }}</dd>
        </div>
      </dl>
    </section>
  </main>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.quant-lab-view {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: calc(100 * var(--vh));
  padding: 32px;
  background: $bg-primary;
  color: $text-primary;
}

.hero-card,
.status-card {
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
}

.hero-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 28px;
}

.eyebrow {
  margin: 0 0 8px;
  color: $accent-primary;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: 32px;
  line-height: 1.15;
}

.subtitle {
  max-width: 680px;
  margin-top: 12px;
  color: $text-secondary;
  line-height: 1.6;
}

.refresh-button {
  border: 1px solid $accent-primary;
  border-radius: $radius-md;
  padding: 10px 14px;
  background: transparent;
  color: $accent-primary;
  cursor: pointer;
  font-weight: 600;

  &:disabled {
    cursor: wait;
    opacity: 0.65;
  }
}

.status-card {
  padding: 24px;
}

.status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.status-pill {
  border-radius: 999px;
  padding: 4px 10px;
  background: $bg-secondary;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 700;

  &.ready {
    background: rgba(34, 197, 94, 0.14);
    color: #16a34a;
  }
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin: 0;
}

dt {
  color: $text-secondary;
  font-size: 12px;
  text-transform: uppercase;
}

dd {
  margin: 6px 0 0;
  font-weight: 600;
}

.error-message {
  color: $error;
}
</style>
