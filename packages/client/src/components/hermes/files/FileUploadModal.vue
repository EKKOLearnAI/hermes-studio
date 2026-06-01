<script setup lang="ts">
import { computed, ref } from 'vue'
import { NModal, NButton, NSpace, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const uploading = ref(false)
const isDragging = ref(false)
const dragCounter = ref(0)
const fileInputRef = ref<HTMLInputElement | null>(null)
const fileList = ref<File[]>([])

const hasFiles = computed(() => fileList.value.length > 0)

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function addFiles(files: File[]) {
  const existing = new Set(fileList.value.map(fileKey))
  const nextFiles = files.filter(file => !existing.has(fileKey(file)))
  if (nextFiles.length === 0) return
  fileList.value = [...fileList.value, ...nextFiles]
}

function handleSelectClick() {
  fileInputRef.value?.click()
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  addFiles(Array.from(input.files))
  input.value = ''
}

function handleDragOver(event: DragEvent) {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
}

function handleDragEnter(event: DragEvent) {
  event.preventDefault()
  if (!event.dataTransfer?.types.includes('Files')) return
  dragCounter.value += 1
  isDragging.value = true
}

function handleDragLeave(event: DragEvent) {
  event.preventDefault()
  dragCounter.value = Math.max(0, dragCounter.value - 1)
  if (dragCounter.value === 0) {
    isDragging.value = false
  }
}

function handleDrop(event: DragEvent) {
  event.preventDefault()
  dragCounter.value = 0
  isDragging.value = false
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length === 0) return
  addFiles(files)
}

function removeFile(index: number) {
  fileList.value = fileList.value.filter((_, currentIndex) => currentIndex !== index)
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

async function handleUpload() {
  if (fileList.value.length === 0) return
  uploading.value = true
  try {
    await filesStore.uploadFiles(fileList.value)
    message.success(t('files.uploadSuccess', { count: fileList.value.length }))
    fileList.value = []
    emit('update:show', false)
  } catch (err: any) {
    message.error(err.message || t('files.uploadFailed'))
  } finally {
    uploading.value = false
  }
}

function handleClose() {
  dragCounter.value = 0
  isDragging.value = false
  fileList.value = []
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="dialog"
    :title="t('files.upload')"
    @update:show="handleClose"
    style="width: 560px;"
  >
    <div class="upload-panel">
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileChange"
      />

      <div
        class="upload-dropzone"
        :class="{ 'drag-over': isDragging }"
        @click="handleSelectClick"
        @dragover="handleDragOver"
        @dragenter="handleDragEnter"
        @dragleave="handleDragLeave"
        @drop="handleDrop"
      >
        <div class="upload-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 16V5" />
            <path d="M8 9l4-4 4 4" />
            <path d="M20 16.5v1.5A2 2 0 0 1 18 20H6a2 2 0 0 1-2-2v-1.5" />
          </svg>
        </div>
        <p class="upload-title">{{ t('files.dragDropHint') }}</p>
        <NButton type="primary" secondary @click.stop="handleSelectClick">
          {{ t('files.upload') }}
        </NButton>
      </div>

      <div v-if="hasFiles" class="selected-files">
        <div
          v-for="(file, index) in fileList"
          :key="fileKey(file)"
          class="selected-file"
        >
          <div class="selected-file__meta">
            <span class="selected-file__name">{{ file.name }}</span>
            <span class="selected-file__size">{{ formatFileSize(file.size) }}</span>
          </div>
          <button
            type="button"
            class="selected-file__remove"
            @click="removeFile(index)"
          >
            ×
          </button>
        </div>
      </div>
    </div>
    <template #action>
      <NSpace>
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="uploading" :disabled="!hasFiles" @click="handleUpload">
          {{ t('files.upload') }} ({{ fileList.length }})
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.upload-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.file-input-hidden {
  display: none;
}

.upload-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 220px;
  padding: 32px 20px;
  text-align: center;
  cursor: pointer;
  border: 2px dashed rgba(24, 160, 88, 0.45);
  border-radius: 14px;
  background: rgba(24, 160, 88, 0.06);
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease,
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.upload-dropzone:hover,
.upload-dropzone.drag-over {
  border-color: rgba(24, 160, 88, 0.9);
  background: rgba(24, 160, 88, 0.12);
  transform: translateY(-1px);
  box-shadow: 0 10px 30px rgba(24, 160, 88, 0.12);
}

.upload-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 999px;
  color: #18a058;
  background: rgba(24, 160, 88, 0.12);
}

.upload-icon svg {
  width: 30px;
  height: 30px;
}

.upload-title {
  margin: 0;
  max-width: 320px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
}

.selected-files {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  overflow-y: auto;
}

.selected-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
}

.selected-file__meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.selected-file__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

.selected-file__size {
  font-size: 12px;
  opacity: 0.65;
}

.selected-file__remove {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 999px;
  color: inherit;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  background: rgba(255, 255, 255, 0.08);
}

.selected-file__remove:hover {
  background: rgba(255, 255, 255, 0.14);
}
</style>
