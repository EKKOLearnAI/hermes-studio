<script setup lang="ts">
import { onMounted } from 'vue'
import { NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import PlatformSettings from '@/components/hermes/settings/PlatformSettings.vue'

const settingsStore = useSettingsStore()
const { t } = useI18n()

onMounted(() => {
  settingsStore.fetchSettings()
})
</script>

<template>
  <div class="channels-view lg-page">
    <header class="lg-header lg-header-row">
      <h2 class="lg-title">{{ t('sidebar.channels') }}</h2>
    </header>

    <div class="channels-content lg-body">
      <NSpin :show="settingsStore.loading || settingsStore.saving" size="large" :description="t('common.loading')">
        <PlatformSettings v-if="!settingsStore.loading" />
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.channels-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.channels-content {
  flex: 1;
  overflow-y: auto;
  position: relative;
}
</style>
