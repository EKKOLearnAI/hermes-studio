<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useScrollReveal } from '@/composables/useScrollReveal'

const { t } = useI18n()
useScrollReveal()
</script>

<template>
  <div class="star-panel">
    <h2 class="panel-title reveal">{{ t('starHistory.title') }}</h2>
    <p class="panel-desc reveal">{{ t('starHistory.desc') }}</p>

    <div class="star-chart reveal reveal-delay-2">
      <div class="community-card">
        <p>{{ t('starHistory.desc') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.star-panel {
  padding: 40px 32px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-lg;
  display: flex;
  flex-direction: column;

  @media (max-width: $breakpoint-mobile) {
    padding: 24px 16px;
  }
}

.panel-title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.panel-desc {
  color: var(--text-secondary);
  font-size: 15px;
  margin-bottom: 24px;
}

.star-chart {
  flex: 1;
  display: flex;
  align-items: center;
}

.community-card {
  width: 100%;
  padding: 24px;
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.7;
}
</style>
