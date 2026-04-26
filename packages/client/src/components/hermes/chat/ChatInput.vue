<script setup lang="ts">
import type { Attachment } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchContextLength } from '@/api/hermes/sessions'
import { NButton, NTooltip } from 'naive-ui'
import { computed, ref, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ImageCropDialog from '@/components/hermes/ImageCropDialog.vue'

const chatStore = useChatStore()
const { t } = useI18n()
const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const avatarInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
const isDragging = ref(false)
const dragCounter = ref(0)
const isComposing = ref(false)
const showCropDialog = ref(false)

// User avatar handlers
function openAvatarPicker() { avatarInputRef.value?.click() }
function onAvatarFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  // Check if animated (GIF/APNG) — skip crop, use directly
  if (file.type === 'image/gif' || file.type === 'image/apng') {
    if (file.size > 5 * 1024 * 1024) { return }
    chatStore.uploadAvatar('user', file)
    return
  }
  showCropDialog.value = true
}
function onAvatarCropped(dataUrl: string) {
  // Convert cropped data URL to File and upload to server
  fetch(dataUrl).then(r => r.blob()).then(blob => {
    const file = new File([blob], 'avatar.png', { type: blob.type })
    chatStore.uploadAvatar('user', file)
  }).catch(() => {})
  showCropDialog.value = false
}

const canSend = computed(() => inputText.value.trim() || attachments.value.length > 0)

// Whether the send button should be enabled (respects busy input mode)
const canSendNow = computed(() => {
  if (!canSend.value) return false
  if (!chatStore.isStreaming) return true
  return chatStore.busyInputMode
})

// --- Context info ---

const contextLength = ref(200000)
const FALLBACK_CONTEXT = 200000

async function loadContextLength() {
  try {
    const profile = useProfilesStore().activeProfileName || undefined
    contextLength.value = await fetchContextLength(profile)
  } catch {
    contextLength.value = FALLBACK_CONTEXT
  }
}

onMounted(loadContextLength)
watch(() => useProfilesStore().activeProfileName, loadContextLength)
watch(() => useAppStore().selectedModel, loadContextLength)

const totalTokens = computed(() => {
  const input = chatStore.activeSession?.inputTokens ?? 0
  const output = chatStore.activeSession?.outputTokens ?? 0
  return input + output
})

const remainingTokens = computed(() => Math.max(0, contextLength.value - totalTokens.value))

const usagePercent = computed(() =>
  Math.min((totalTokens.value / contextLength.value) * 100, 100),
)

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// --- File attachment helpers ---

function addFile(file: File) {
  if (attachments.value.find(a => a.name === file.name)) return
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const url = URL.createObjectURL(file)
  attachments.value.push({
    id,
    name: file.name,
    type: file.type,
    size: file.size,
    url,
    file,
  })
}

function handleAttachClick() {
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  for (const file of input.files) addFile(file)
  input.value = ''
}

// --- Paste image ---

function handlePaste(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items || [])
  const imageItems = items.filter(i => i.type.startsWith('image/'))
  if (!imageItems.length) return
  e.preventDefault()
  for (const item of imageItems) {
    const blob = item.getAsFile()
    if (!blob) continue
    const ext = item.type.split('/')[1] || 'png'
    const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type })
    addFile(file)
  }
}

// --- Drag and drop ---

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer?.types.includes('Files')) {
    dragCounter.value++
    isDragging.value = true
  }
}

function handleDragLeave() {
  dragCounter.value--
  if (dragCounter.value <= 0) {
    dragCounter.value = 0
    isDragging.value = false
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  dragCounter.value = 0
  isDragging.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  for (const file of files) addFile(file)
  textareaRef.value?.focus()
}

// --- Send ---

function handleSend() {
  const text = inputText.value.trim()
  if (!text && attachments.value.length === 0) return

  chatStore.sendMessage(text, attachments.value.length > 0 ? attachments.value : undefined)
  inputText.value = ''
  attachments.value = []

  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }
}

function handleCompositionStart() {
  isComposing.value = true
}

function handleCompositionEnd() {
  requestAnimationFrame(() => {
    isComposing.value = false
  })
}

function isImeEnter(e: KeyboardEvent): boolean {
  return isComposing.value || e.isComposing || e.keyCode === 229
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  if (isImeEnter(e)) return

  e.preventDefault()
  handleSend()
}

function handleInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 100) + 'px'
}

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id)
  if (idx !== -1) {
    URL.revokeObjectURL(attachments.value[idx].url)
    attachments.value.splice(idx, 1)
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function isImage(type: string): boolean {
  return type.startsWith('image/')
}
</script>

<template>
  <div class="chat-input-area">
    <!-- Top bar: attach + context info -->
    <div class="input-top-bar">
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton quaternary size="tiny" @click="handleAttachClick" circle>
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </template>
          </NButton>
        </template>
        {{ t('chat.attachFiles') }}
      </NTooltip>
      <span v-if="totalTokens > 0" class="context-info" :class="{ 'context-warning': usagePercent > 80 }">
        {{ formatTokens(totalTokens) }} / {{ formatTokens(contextLength) }} · {{ t('chat.contextRemaining') }} {{ formatTokens(remainingTokens) }}
      </span>
      <div v-if="totalTokens > 0" class="context-bar">
        <div
          class="context-bar-fill"
          :class="{
            'context-bar-warn': usagePercent > 60 && usagePercent <= 80,
            'context-bar-danger': usagePercent > 80,
          }"
          :style="{ width: `${usagePercent}%` }"
        />
      </div>
    </div>

    <!-- Attachment previews -->
    <div v-if="attachments.length > 0" class="attachment-previews">
      <div
        v-for="att in attachments"
        :key="att.id"
        class="attachment-preview"
        :class="{ image: isImage(att.type) }"
      >
        <template v-if="isImage(att.type)">
          <img :src="att.url" :alt="att.name" class="attachment-thumb" />
        </template>
        <template v-else>
          <div class="attachment-file">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="file-name">{{ att.name }}</span>
            <span class="file-size">{{ formatSize(att.size) }}</span>
          </div>
        </template>
        <button class="attachment-remove" @click="removeAttachment(att.id)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <div
      class="input-wrapper"
      :class="{ 'drag-over': isDragging }"
      @dragover="handleDragOver"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileChange"
      />
      <input
        ref="avatarInputRef"
        type="file"
        accept="image/*"
        class="file-input-hidden"
        @change="onAvatarFileChange"
      />
      <div class="user-avatar" @click="openAvatarPicker" :title="t('chat.changeAvatar')">
        <img v-if="chatStore.userAvatar" :src="chatStore.userAvatar" alt="avatar" />
        <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      </div>
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-textarea"
        :placeholder="chatStore.isStreaming && chatStore.busyInputMode ? t('chat.interruptPlaceholder') : t('chat.inputPlaceholder')"
        rows="1"
        @keydown="handleKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @input="handleInput"
        @paste="handlePaste"
      ></textarea>
      <div class="input-actions">
        <NButton
          v-if="chatStore.isStreaming"
          size="small"
          type="error"
          @click="chatStore.stopStreaming()"
        >
          {{ t('chat.stop') }}
        </NButton>
        <NButton
          size="small"
          :type="chatStore.isStreaming && chatStore.busyInputMode ? 'warning' : 'primary'"
          :disabled="!canSendNow"
          @click="handleSend"
        >
          <template #icon>
            <svg v-if="chatStore.isStreaming && chatStore.busyInputMode" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </template>
          {{ chatStore.isStreaming && chatStore.busyInputMode ? t('chat.interrupt') : t('chat.send') }}
        </NButton>
      </div>
    </div>
  </div>
  <ImageCropDialog :show="showCropDialog" @confirm="onAvatarCropped" @close="showCropDialog = false" />
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.chat-input-area {
  padding: 12px 20px 16px;
  border-top: 1px solid $border-color;
  flex-shrink: 0;
}

.input-top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 6px;
}

.context-info {
  font-size: 11px;
  color: $text-muted;

  &.context-warning {
    color: #e8a735;
  }
}

.context-bar {
  width: 60px;
  height: 4px;
  background: rgba(128, 128, 128, 0.2);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(128, 128, 128, 0.3), rgba(128, 128, 128, 0.6));
  border-radius: 2px;
  transition: width 0.3s ease;

  &.context-bar-warn {
    background: linear-gradient(90deg, #c98a1a, #e8a735);
  }

  &.context-bar-danger {
    background: linear-gradient(90deg, #c43a2a, #e85d4a);
  }
}

.attachment-previews {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 10px;
}

.attachment-preview {
  position: relative;
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: $bg-secondary;
  border: 1px solid $border-color;

  &.image {
    width: 64px;
    height: 64px;
  }
}

.attachment-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment-file {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 8px 12px;
  min-width: 80px;
  max-width: 140px;
  color: $text-secondary;

  .file-name {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .file-size {
    font-size: 10px;
    color: $text-muted;
  }
}

.attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.5);
  color: var(--text-on-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity $transition-fast;

  .attachment-preview:hover & {
    opacity: 1;
  }
}

.file-input-hidden {
  display: none;
}

.input-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
  background-color: $bg-input;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 10px 12px;
  transition: border-color $transition-fast, background-color $transition-fast;

  &:focus-within {
    border-color: $accent-primary;
  }

  .dark & {
    background-color: #333333;
  }
}

.input-textarea {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: $text-primary;
  font-family: $font-ui;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  max-height: 100px;
  min-height: 20px;
  overflow-y: auto;

  &::placeholder {
    color: $text-muted;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.input-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}

// User avatar
.user-avatar {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  transition: opacity $transition-fast;
  &:hover { opacity: 0.8; }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  svg { color: $text-muted; }
}

.input-wrapper.drag-over {
  border-color: var(--accent-info);
  border-style: dashed;
  background-color: rgba(var(--accent-info-rgb), 0.04);
}
</style>
