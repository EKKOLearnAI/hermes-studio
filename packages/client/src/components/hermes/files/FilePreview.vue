<script setup lang="ts">
import { computed, h } from 'vue'
import { NButton, NIcon, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { getFileDownloadUrl } from '@/api/hermes/files'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

function getImageUrl(): string {
  if (!filesStore.previewFile) return ''
  return getFileDownloadUrl(filesStore.previewFile.path, undefined, filesStore.previewFile.profile)
}

const highlightedPreview = computed(() => {
  const previewFile = filesStore.previewFile
  if (!previewFile || previewFile.type !== 'text') return ''
  return renderHighlightedCodeBlock(previewFile.content || '', previewFile.language, t('common.copy'), {
    maxHighlightLength: 200_000,
  })
})

async function handlePreviewClick(event: MouseEvent) {
  const copyResult = await handleCodeBlockCopyClick(event)
  if (copyResult) {
    message.success(t('common.copied'))
  } else if (copyResult === false) {
    message.error(t('chat.copyFailed'))
  }
}

const CloseIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', width: '14', height: '14', fill: 'currentColor' },
    [h('path', { d: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' })],
  )
</script>

<template>
  <div class="file-preview" v-if="filesStore.previewFile">
    <div class="preview-header">
      <span class="preview-filename">{{ filesStore.previewFile.path }}</span>
      <NButton size="small" quaternary @click="filesStore.closePreview()">
        <template #icon>
          <NIcon><CloseIcon /></NIcon>
        </template>
        {{ t('files.closePreview') }}
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
      <div
        v-else-if="filesStore.previewFile.type === 'text'"
        class="preview-code"
        v-html="highlightedPreview"
        @click="handlePreviewClick"
      />
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

.preview-code {
  width: 100%;

  :deep(.hljs-code-block) {
    margin: 0;
  }
}
</style>
