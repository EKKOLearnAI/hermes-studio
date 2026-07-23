<script setup lang="ts">
import { computed, defineAsyncComponent, h, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { NAlert, NButton, NIcon, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { fetchFilePreviewBlob } from '@/api/hermes/files'
import { downloadFile } from '@/api/hermes/download'
import { downloadSessionWorkspaceFile, fetchSessionWorkspaceFileBlob } from '@/api/hermes/sessions'
import { downloadGroupWorkspaceFile, fetchGroupWorkspaceFileBlob } from '@/api/hermes/group-chat'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'
import { previewMimeMatches } from '@/utils/hermes/file-preview'
import { openHtmlInDesktopBrowser } from '@/utils/desktop-browser'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)
const HtmlFilePreview = defineAsyncComponent(async () => (await import('./HtmlFilePreview.vue')).default)
const PdfFilePreview = defineAsyncComponent(async () => (await import('./PdfFilePreview.vue')).default)
const DocxFilePreview = defineAsyncComponent(async () => (await import('./DocxFilePreview.vue')).default)
const PptxFilePreview = defineAsyncComponent(async () => (await import('./PptxFilePreview.vue')).default)
const SpreadsheetFilePreview = defineAsyncComponent(async () => (await import('./SpreadsheetFilePreview.vue')).default)

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()
const props = defineProps<{ customClose?: () => void }>()
const loading = ref(false)
const downloading = ref(false)
const previewError = ref('')
const previewText = ref('')
const previewBuffer = shallowRef<ArrayBuffer | null>(null)
const imageUrl = ref('')
let requestController: AbortController | null = null
let requestGeneration = 0

function revokeImageUrl(): void {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
  imageUrl.value = ''
}

function resetLoadedPreview(): void {
  requestController?.abort()
  requestController = null
  revokeImageUrl()
  previewText.value = ''
  previewBuffer.value = null
  previewError.value = ''
  loading.value = false
}

async function loadPreview(): Promise<void> {
  const generation = ++requestGeneration
  resetLoadedPreview()
  const file = filesStore.previewFile
  if (!file || file.type === 'markdown' || file.type === 'text') return
  requestController = new AbortController()
  loading.value = true
  try {
    const blob = file.workspaceRoomId
      ? await fetchGroupWorkspaceFileBlob(file.workspaceRoomId, file.path, requestController.signal)
      : file.workspaceSessionId
        ? await fetchSessionWorkspaceFileBlob(file.workspaceSessionId, file.path, requestController.signal)
        : await fetchFilePreviewBlob(file.path, file.profile, requestController.signal)
    if (generation !== requestGeneration) return
    if (!previewMimeMatches(file.type, blob.type)) {
      throw new Error(t('files.previewMimeMismatch'))
    }
    if (file.type === 'image') {
      imageUrl.value = URL.createObjectURL(blob)
    } else if (file.type === 'html' || file.type === 'csv') {
      const text = await blob.text()
      if (generation !== requestGeneration) return
      previewText.value = text
      if (file.type === 'html' && await openHtmlInDesktopBrowser(text, file.name)) return
    } else {
      const buffer = await blob.arrayBuffer()
      if (generation !== requestGeneration) return
      previewBuffer.value = buffer
    }
  } catch (error) {
    if ((error as any)?.name !== 'AbortError' && generation === requestGeneration) {
      previewError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

function handleRendererError(error: Error): void {
  previewError.value = error.message || t('files.previewFailed')
}

async function handleDownload(): Promise<void> {
  const file = filesStore.previewFile
  if (!file || downloading.value) return
  downloading.value = true
  try {
    if (file.workspaceRoomId) {
      await downloadGroupWorkspaceFile(file.workspaceRoomId, file.path, file.name)
    } else if (file.workspaceSessionId) {
      await downloadSessionWorkspaceFile(file.workspaceSessionId, file.path, file.name)
    } else {
      await downloadFile(file.path, file.name, file.profile)
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('download.downloadFailed'))
  } finally {
    downloading.value = false
  }
}

function handleClose(): void {
  if (props.customClose) props.customClose()
  else filesStore.closePreview()
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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

watch(() => filesStore.previewFile, () => { void loadPreview() }, { immediate: true })
onBeforeUnmount(() => {
  requestGeneration += 1
  resetLoadedPreview()
})
</script>

<template>
  <div class="file-preview" v-if="filesStore.previewFile">
    <div class="preview-header">
      <div class="preview-file-info">
        <span class="preview-filename">{{ filesStore.previewFile.path }}</span>
        <span class="preview-size">{{ formatSize(filesStore.previewFile.size) }}</span>
      </div>
      <div class="preview-actions">
        <NButton size="small" secondary :loading="downloading" @click="handleDownload">{{ t('files.download') }}</NButton>
        <NButton size="small" quaternary @click="handleClose">
          <template #icon>
            <NIcon><CloseIcon /></NIcon>
          </template>
          {{ t('files.closePreview') }}
        </NButton>
      </div>
    </div>
    <div class="preview-content">
      <NSpin v-if="loading" :description="t('files.previewLoading')" />
      <NAlert v-else-if="previewError" type="error" class="preview-error">
        <template #header>{{ t('files.previewFailed') }}</template>
        <div class="preview-error-message">{{ previewError }}</div>
        <div class="preview-error-action">
          <NButton size="small" :loading="downloading" @click="handleDownload">{{ t('files.downloadInstead') }}</NButton>
        </div>
      </NAlert>
      <img
        v-else-if="filesStore.previewFile.type === 'image' && imageUrl"
        :src="imageUrl"
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
      <HtmlFilePreview
        v-else-if="filesStore.previewFile.type === 'html'"
        :content="previewText"
      />
      <PdfFilePreview
        v-else-if="filesStore.previewFile.type === 'pdf' && previewBuffer"
        :data="previewBuffer"
        @error="handleRendererError"
      />
      <DocxFilePreview
        v-else-if="filesStore.previewFile.type === 'docx' && previewBuffer"
        :data="previewBuffer"
        @error="handleRendererError"
      />
      <PptxFilePreview
        v-else-if="filesStore.previewFile.type === 'presentation' && previewBuffer"
        :data="previewBuffer"
        @error="handleRendererError"
      />
      <SpreadsheetFilePreview
        v-else-if="filesStore.previewFile.type === 'spreadsheet' && previewBuffer"
        kind="spreadsheet"
        :data="previewBuffer"
        @error="handleRendererError"
      />
      <SpreadsheetFilePreview
        v-else-if="filesStore.previewFile.type === 'csv'"
        kind="csv"
        :source="previewText"
        @error="handleRendererError"
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

.preview-file-info,
.preview-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.preview-filename {
  font-size: 13px;
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-size {
  flex: none;
  font-size: 12px;
  color: $text-muted;
}

.preview-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  justify-content: center;
  min-height: 0;
}

.preview-error { width: min(680px, 100%); align-self: flex-start; }
.preview-error-message { overflow-wrap: anywhere; }
.preview-error-action { margin-top: 12px; }

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
