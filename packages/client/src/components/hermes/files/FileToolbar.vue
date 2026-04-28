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
    <NSpace>
      <NButton size="small" @click="emit('showNewFile')">
        {{ t('files.newFile') }}
      </NButton>
      <NButton size="small" @click="emit('showNewFolder')">
        {{ t('files.newFolder') }}
      </NButton>
      <NButton size="small" @click="emit('showUpload')">
        {{ t('files.upload') }}
      </NButton>
      <NButton size="small" @click="handleRefresh">
        {{ t('files.refresh') }}
      </NButton>
    </NSpace>
  </div>
</template>

<style scoped lang="scss">
.file-toolbar {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}
</style>
