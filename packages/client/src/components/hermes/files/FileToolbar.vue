<script setup lang="ts">
import { NButton, NSpace, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

const emit = defineEmits<{
  (e: 'showNewFile'): void
  (e: 'showNewFolder'): void
  (e: 'showUpload'): void
}>()

async function handleRefresh() {
  try {
    await filesStore.fetchEntries()
  } catch {
    message.error(t('files.backendError'))
  }
}
</script>

<template>
  <div class="file-toolbar">
    <NSpace :size="8" :wrap="true" class="toolbar-space">
      <NButton size="small" @click="emit('showNewFile')" class="toolbar-btn">
        {{ t('files.newFile') }}
      </NButton>
      <NButton size="small" @click="emit('showNewFolder')" class="toolbar-btn">
        {{ t('files.newFolder') }}
      </NButton>
      <NButton size="small" @click="emit('showUpload')" class="toolbar-btn">
        {{ t('files.upload') }}
      </NButton>
      <NButton size="small" @click="handleRefresh" class="toolbar-btn">
        {{ t('files.refresh') }}
      </NButton>
    </NSpace>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-toolbar {
  padding: 12px 16px;

  @media (max-width: $breakpoint-mobile) {
    padding: 8px 4px;
  }
}

.toolbar-space {
  @media (max-width: $breakpoint-mobile) {
    :deep(.n-space) {
      gap: 4px !important;
    }
  }
}

.toolbar-btn {
  @media (max-width: $breakpoint-mobile) {
    font-size: 12px;
    padding: 0 8px;
    height: 32px;
    white-space: nowrap;
  }
}
</style>
