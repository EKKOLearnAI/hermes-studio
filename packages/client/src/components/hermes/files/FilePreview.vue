<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { getFileDownloadUrl } from '@/api/hermes/files'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

const { t } = useI18n()
const filesStore = useFilesStore()

function getImageUrl(): string {
  if (!filesStore.previewFile) return ''
  return getFileDownloadUrl(filesStore.previewFile.path)
}
</script>

<template>
  <div class="file-preview" v-if="filesStore.previewFile">
    <div class="preview-header">
      <span class="preview-filename">{{ filesStore.previewFile.path }}</span>
      <NButton size="small" @click="filesStore.closePreview()">
        {{ t('common.cancel') }}
      </NButton>
    </div>
    <div class="preview-content">
      <img
        v-if="filesStore.previewFile.type === 'image'"
        :src="getImageUrl()"
        class="preview-image"
        :alt="filesStore.previewFile.path"
      />
      <div v-else-if="filesStore.previewFile.type === 'markdown'" class="preview-markdown">
        <MarkdownRenderer :content="filesStore.previewFile.content || ''" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
}

.preview-filename {
  font-size: 13px;
  color: $text-secondary;
}

.preview-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  justify-content: center;
}

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-markdown {
  max-width: 800px;
  width: 100%;
}
</style>
