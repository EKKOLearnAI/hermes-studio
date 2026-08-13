<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="app-connections-panel">
    <header class="panel-header">
      <div class="panel-heading">
        <h2>{{ t('connections.tabs.app') }}</h2>
        <p>{{ t('connections.app.subtitle') }}</p>
      </div>
      <NButton size="small" type="primary">
        {{ t('connections.app.scanToAdd') }}
      </NButton>
    </header>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-connections-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panel-header {
  flex: 0 0 auto;
  min-height: 68px;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid $border-color;
}

.panel-heading {
  min-width: 0;

  h2 {
    margin: 0;
    color: $text-primary;
    font-size: 16px;
    font-weight: 650;
    line-height: 22px;
  }

  p {
    margin: 2px 0 0;
    color: $text-muted;
    font-size: 12px;
    line-height: 18px;
  }
}

@media (max-width: $breakpoint-mobile) {
  .panel-header {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }
}
</style>
