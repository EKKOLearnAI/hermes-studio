<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import GithubPreviewSettings from '@/components/hermes/settings/GithubPreviewSettings.vue'

const { t } = useI18n()
</script>

<template>
  <div class="version-preview-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('githubPreview.title') }}</h2>
    </header>

    <div class="page-content">
      <GithubPreviewSettings />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.version-preview-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.page-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
