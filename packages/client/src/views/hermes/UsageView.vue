<script setup lang="ts">
import { NButton } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'
import StatCards from '@/components/hermes/usage/StatCards.vue'
import ModelBreakdown from '@/components/hermes/usage/ModelBreakdown.vue'
import DailyTrend from '@/components/hermes/usage/DailyTrend.vue'

const { t } = useI18n()
const usageStore = useUsageStore()

const periodOptions = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
] as const

const selectedPeriod = ref(30)

function loadUsage(days = selectedPeriod.value) {
  selectedPeriod.value = days
  usageStore.loadSessions(days)
}

onMounted(() => {
  loadUsage(30)
})
</script>

<template>
  <div class="usage-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('usage.title') }}</h2>
      <div class="usage-toolbar">
        <div class="period-selector" role="group" aria-label="Usage statistics period">
          <NButton
            v-for="option in periodOptions"
            :key="option.days"
            class="period-option"
            size="small"
            :type="selectedPeriod === option.days ? 'primary' : 'default'"
            :secondary="selectedPeriod === option.days"
            :quaternary="selectedPeriod !== option.days"
            :aria-pressed="selectedPeriod === option.days"
            @click="loadUsage(option.days)"
          >
            {{ option.label }}
          </NButton>
        </div>
        <NButton class="refresh-button" size="small" quaternary :loading="usageStore.isLoading" @click="loadUsage()">
          {{ t('usage.refresh') }}
        </NButton>
      </div>
    </header>

    <div class="usage-content">
      <div v-if="usageStore.isLoading && !usageStore.hasData" class="usage-loading">
        {{ t('common.loading') }}
      </div>

      <template v-else-if="usageStore.hasData">
        <StatCards />
        <ModelBreakdown />
        <DailyTrend />
      </template>

      <div v-else class="usage-empty">
        {{ t('usage.noData') }}
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usage-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.page-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
}

.header-title {
  margin: 0;
  color: $text-primary;
  font-size: 16px;
  font-weight: 600;
}

.usage-toolbar,
.period-selector {
  display: flex;
  align-items: center;
  gap: 8px;
}

.period-selector {
  padding: 2px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: $bg-secondary;
}

.usage-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  scrollbar-width: none;
  -ms-overflow-style: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.usage-loading,
.usage-empty {
  text-align: center;
  padding: 60px 0;
  color: $text-muted;
  font-size: 14px;
}

@media (max-width: $breakpoint-mobile) {
  .page-header,
  .usage-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .usage-toolbar {
    width: 100%;
  }

  .period-selector {
    flex-wrap: wrap;
  }
}
</style>
