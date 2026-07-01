<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown, NTooltip, type DropdownOption } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import { buildMentionOptions, type MentionOption } from './mention-options'
import type { Attachment } from '@/stores/hermes/chat'
import { clampChatInputHeight, isMobileChatInputViewport } from '@/utils/chat-input-height'

const { t } = useI18n()
const emit = defineEmits<{ send: [content: string, attachments?: Attachment[]] }>()
const store = useGroupChatStore()
const settingsStore = useSettingsStore()
const { toolTraceVisible, toggleToolTraceVisible } = useToolTraceVisibility()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const dropdownRef = ref<HTMLDivElement>()
const fileInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
const isDragging = ref(false)
const dragCounter = ref(0)
const isComposing = ref(false)
const autoPlaySpeech = ref(false)
const inputSettingsOptions = computed<DropdownOption[]>(() => [
    {
        label: t('chat.autoPlaySpeech'),
        key: 'autoPlaySpeech',
        icon: () => h('span', {
            class: ['settings-check', { active: autoPlaySpeech.value }],
            'aria-hidden': 'true',
        }, autoPlaySpeech.value ? '✓' : ''),
    },
    {
        label: t('chat.showToolCalls'),
        key: 'toolTrace',
        icon: () => h('span', {
            class: ['settings-check', { active: toolTraceVisible.value }],
            'aria-hidden': 'true',
        }, toolTraceVisible.value ? '✓' : ''),
    },
])
const isMobileViewport = ref(typeof window !== 'undefined' ? isMobileChatInputViewport(window.innerWidth) : false)
const manualTextareaResize = ref(false)
const configuredTextareaHeight = computed(() =>
    isMobileViewport.value ? null : clampChatInputHeight(settingsStore.display.chat_input_height),
)

onMounted(() => {
    const saved = localStorage.getItem('autoPlaySpeech')
    if (saved !== null) {
        autoPlaySpeech.value = saved === 'true'
        store.setAutoPlaySpeech(autoPlaySpeech.value)
    }
    syncViewport()
    window.addEventListener('resize', syncViewport)
    nextTick(() => {
        applyConfiguredTextareaHeight()
    })
})

watch(autoPlaySpeech, (value) => {
    localStorage.setItem('autoPlaySpeech', String(value))
    store.setAutoPlaySpeech(value)
})

function handleInputSettingsSelect(key: string | number) {
    if (key === 'autoPlaySpeech') {
        autoPlaySpeech.value = !autoPlaySpeech.value
        return
    }

    if (key === 'toolTrace') {
        toggleToolTraceVisible()
    }
}

watch(configuredTextareaHeight, () => {
    applyConfiguredTextareaHeight()
})

// 自定义高度拖拽
const textareaHeight = ref<number | null>(null)

function syncViewport() {
  if (typeof window === 'undefined') return
  isMobileViewport.value = isMobileChatInputViewport(window.innerWidth)
}

function resetTextareaHeight() {
    manualTextareaResize.value = false
    applyConfiguredTextareaHeight()
}

function autoSizeTextarea(el: HTMLTextAreaElement | undefined = textareaRef.value) {
    if (!el || textareaHeight.value !== null) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 100) + 'px'
}

function applyConfiguredTextareaHeight() {
    if (manualTextareaResize.value) return

    textareaHeight.value = configuredTextareaHeight.value

    const textarea = textareaRef.value
    if (!textarea) return

    if (textareaHeight.value === null) {
        autoSizeTextarea(textarea)
        return
    }

    textarea.style.height = `${textareaHeight.value}px`
}

function startResize(e: MouseEvent) {
  e.preventDefault()
  const el = textareaRef.value
  if (!el) return
  manualTextareaResize.value = true
  const startHeight = el.clientHeight
  const startY = e.clientY

  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    const newHeight = startHeight - deltaY
    textareaHeight.value = clampChatInputHeight(newHeight) ?? textareaHeight.value
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

// ─── Mention State ───────────────────────────────────────

const mentionActive = ref(false)
const mentionQuery = ref('')
const mentionStartIndex = ref(-1)
const dropdownX = ref(0)
const dropdownY = ref(0)
const dropdownBottom = ref(0)
const placement = ref<'bottom' | 'top'>('bottom')
const activeIndex = ref(0)

const filteredMentionOptions = computed(() => buildMentionOptions(store.agents, mentionQuery.value))

const canSend = computed(() => !!inputText.value.trim() || attachments.value.length > 0)

// ─── Scroll active item into view ──────────────────────

function scrollToActive() {
    nextTick(() => {
        if (!dropdownRef.value) return
        const active = dropdownRef.value.querySelector('.active') as HTMLElement | null
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    })
}

// ─── Mention Logic ───────────────────────────────────────

function updateMentionState() {
    const el = textareaRef.value
    if (!el) { mentionActive.value = false; return }

    const text = inputText.value
    const cursorPos = el.selectionStart

    // Find the last @ before the cursor
    let atPos = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
        if (text[i] === '@') { atPos = i; break }
        if (text[i] === ' ' || text[i] === '\n') break
    }

    if (atPos === -1) {
        mentionActive.value = false
        return
    }

    // Make sure the @ is not part of a word (preceded by space or start of line)
    if (atPos > 0 && text[atPos - 1] !== ' ' && text[atPos - 1] !== '\n') {
        mentionActive.value = false
        return
    }

    const query = text.slice(atPos + 1, cursorPos)
    if (query.includes(' ')) {
        mentionActive.value = false
        return
    }

    mentionQuery.value = query
    mentionStartIndex.value = atPos
    activeIndex.value = 0

    // Calculate dropdown position using mirror span
    const mirror = document.createElement('span')
    const style = getComputedStyle(el)
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent', 'border', 'padding', 'boxSizing', 'lineHeight']
    props.forEach(p => { (mirror.style as any)[p] = style[p as any] })
    mirror.style.position = 'absolute'
    mirror.style.visibility = 'hidden'
    mirror.style.whiteSpace = 'nowrap'
    mirror.textContent = text.slice(0, atPos + 1)

    const rect = el.getBoundingClientRect()
    document.body.appendChild(mirror)
    const mirrorRect = mirror.getBoundingClientRect()
    document.body.removeChild(mirror)

    dropdownX.value = rect.left + mirrorRect.width - el.scrollLeft

    // Decide placement: if dropdown would go below viewport, flip upward
    const estimatedHeight = Math.min(filteredMentionOptions.value.length * 36 + 8, 240)
    const spaceBelow = window.innerHeight - rect.top + el.scrollTop - 8
    if (spaceBelow < estimatedHeight && rect.top - el.scrollTop - 8 > estimatedHeight) {
        placement.value = 'top'
        dropdownY.value = rect.top - el.scrollTop - 8
    } else {
        placement.value = 'bottom'
        dropdownY.value = rect.top - el.scrollTop - 8
    }

    dropdownBottom.value = window.innerHeight - dropdownY.value

    mentionActive.value = filteredMentionOptions.value.length > 0
}

function selectMention(name: string) {
    const el = textareaRef.value
    if (!el || mentionStartIndex.value === -1) return

    const before = inputText.value.slice(0, mentionStartIndex.value)
    const after = inputText.value.slice(el.selectionStart)
    inputText.value = `${before}@${name} ${after}`
    mentionActive.value = false

    nextTick(() => {
        if (el) {
            const newPos = before.length + name.length + 2
            el.setSelectionRange(newPos, newPos)
            el.focus()
            autoSizeTextarea(el)
        }
    })
}

// ─── Event Handlers ──────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
    // Mention navigation — fully custom, no NDropdown interference
    if (mentionActive.value && filteredMentionOptions.value.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value + 1) % filteredMentionOptions.value.length
            scrollToActive()
            return
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value - 1 + filteredMentionOptions.value.length) % filteredMentionOptions.value.length
            scrollToActive()
            return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            selectMention(filteredMentionOptions.value[activeIndex.value].name)
            return
        }
        if (e.key === 'Escape') {
            e.preventDefault()
            mentionActive.value = false
            return
        }
    }

    if (e.key !== 'Enter' || e.shiftKey) return
    if (isComposing.value || e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    handleSend()
}

function handleSend() {
    const content = inputText.value.trim()
    if (!content && attachments.value.length === 0) return

    emit('send', content, attachments.value.length > 0 ? attachments.value : undefined)
    inputText.value = ''
    attachments.value = []
    mentionActive.value = false
    // 发送后重置到自定义高度（不清除拖拽状态）
}

function handleInput(e: Event) {
    store.emitTyping()
    if (!isComposing.value) {
        updateMentionState()
    }

    // 用户手动拖拽自定义高度时，不覆盖
    if (textareaHeight.value !== null) return
    const el = e.target as HTMLTextAreaElement
    autoSizeTextarea(el)
}

function handleMentionClick(option: MentionOption) {
    selectMention(option.name)
}

function handleMentionHover(index: number) {
    activeIndex.value = index
}

// ─── Click outside to close dropdown ─────────────────

function onDocumentMousedown(e: MouseEvent) {
    if (!mentionActive.value) return
    const target = e.target as HTMLElement
    if (!target.closest('.mention-dropdown')) {
        mentionActive.value = false
    }
}

onMounted(() => {
    document.addEventListener('mousedown', onDocumentMousedown)
})

onUnmounted(() => {
    document.removeEventListener('mousedown', onDocumentMousedown)
    window.removeEventListener('resize', syncViewport)
})

function handleCompositionStart() {
    isComposing.value = true
}

function handleCompositionEnd() {
    requestAnimationFrame(() => {
        isComposing.value = false
        updateMentionState()
    })
}

function addFile(file: File) {
    if (attachments.value.find(a => a.name === file.name)) return
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    attachments.value.push({
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        url: URL.createObjectURL(file),
        file,
    })
}

function addFiles(files: File[]) {
    for (const file of files) addFile(file)
    if (files.length > 0) textareaRef.value?.focus()
}

function handleAttachClick() {
    fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    addFiles(Array.from(input.files))
    input.value = ''
}

function handlePaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items || [])
    const imageItems = items.filter(i => i.type.startsWith('image/'))
    if (!imageItems.length) return
    e.preventDefault()
    for (const item of imageItems) {
        const blob = item.getAsFile()
        if (!blob) continue
        const ext = item.type.split('/')[1] || 'png'
        addFiles([new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type })])
    }
}

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
    addFiles(Array.from(e.dataTransfer?.files || []))
}

defineExpose({ addFiles })

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
        <div v-if="attachments.length > 0" class="attachment-previews">
            <div v-for="att in attachments" :key="att.id" class="attachment-preview" :class="{ image: isImage(att.type) }">
                <img v-if="isImage(att.type)" :src="att.url" :alt="att.name" class="attachment-thumb" />
                <div v-else class="attachment-file">
                    <span class="file-name">{{ att.name }}</span>
                    <span class="file-size">{{ formatSize(att.size) }}</span>
                </div>
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
            <input ref="fileInputRef" type="file" multiple class="file-input-hidden" @change="handleFileChange" />
            <div class="resize-handle" :title="t('chat.inputHeightResizeHint')" @mousedown="startResize" @dblclick="resetTextareaHeight"></div>
            <textarea
                ref="textareaRef"
                v-model="inputText"
                class="input-textarea"
                :style="textareaHeight ? { height: textareaHeight + 'px' } : {}"
                :placeholder="t('groupChat.inputPlaceholder')"
                rows="1"
                @keydown="handleKeydown"
                @compositionstart="handleCompositionStart"
                @compositionend="handleCompositionEnd"
                @input="handleInput"
                @paste="handlePaste"
            />
            <div class="input-toolbar">
                <div class="input-top-bar">
                    <NTooltip trigger="hover">
                        <template #trigger>
                            <NButton quaternary size="tiny" circle class="toolbar-icon-button" @click="handleAttachClick">
                                <template #icon>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                                </template>
                            </NButton>
                        </template>
                        {{ t('chat.attachFiles') }}
                    </NTooltip>
                    <NDropdown
                        trigger="click"
                        :options="inputSettingsOptions"
                        :show-arrow="true"
                        @select="handleInputSettingsSelect"
                    >
                        <NTooltip trigger="hover">
                            <template #trigger>
                                <NButton quaternary size="tiny" class="input-settings-button" :aria-label="t('sidebar.settings')">
                                    <template #icon>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="12" cy="12" r="3"/>
                                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.3l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.2.6.77 1 1.4 1H21a2 2 0 1 1 0 4h-.09c-.63 0-1.2.4-1.51 1Z"/>
                                        </svg>
                                    </template>
                                    <span class="input-settings-label">{{ t('sidebar.settings') }}</span>
                                    <svg class="toolbar-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                                </NButton>
                            </template>
                            {{ t('sidebar.settings') }}
                        </NTooltip>
                    </NDropdown>
                </div>
                <div class="input-actions">
                    <NButton
                        size="medium"
                        type="primary"
                        circle
                        class="send-button"
                        :disabled="!canSend"
                        :aria-label="t('chat.send')"
                        @click="handleSend"
                    >
                        <template #icon>
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                        </template>
                        <span class="visually-hidden">{{ t('chat.send') }}</span>
                    </NButton>
                </div>
            </div>
        </div>
        <Transition name="dropdown-fade">
            <div
                v-if="mentionActive && filteredMentionOptions.length > 0"
                ref="dropdownRef"
                class="mention-dropdown"
                :class="{ 'placement-top': placement === 'top' }"
                :style="{
                    left: dropdownX + 'px',
                    top: placement === 'bottom' ? dropdownY + 'px' : 'auto',
                    bottom: placement === 'top' ? dropdownBottom + 'px' : 'auto',
                }"
            >
                <div
                    v-for="(option, i) in filteredMentionOptions"
                    :key="option.key"
                    class="mention-dropdown-item"
                    :class="{ active: i === activeIndex, 'mention-all-option': option.type === 'all' }"
                    @mousedown.prevent="handleMentionClick(option)"
                    @mouseenter="handleMentionHover(i)"
                >
                    <span class="mention-name">{{ option.label }}</span>
                    <span class="mention-profile">{{ option.description }}</span>
                </div>
            </div>
        </Transition>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.chat-input-area {
    padding: 8px 20px 14px;
    border-top: 0;
    background-color: $bg-card;
    flex-shrink: 0;
}

.input-top-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    flex: 1;
    padding: 0;
}

.auto-play-speech-switch {
    display: flex;
    align-items: center;
    gap: 5px;
    padding-left: 2px;
    margin-left: 0;

    .switch-label {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: #999999;
    }
}

.tool-trace-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #999999;
    width: 24px;
    min-width: 24px;
    height: 22px;
    margin-left: 0;
    padding: 0;
    background: transparent !important;

    :deep(.n-button__state-border),
    :deep(.n-button__border),
    :deep(.n-button__ripple) {
        display: none;
    }

    .tool-trace-icon {
        display: block;
        width: 16px;
        height: 16px;
    }
}

.input-settings-button {
    color: $text-secondary;
    border-radius: 999px;
    padding: 0 7px 0 6px;

    :deep(.n-button__content) {
        gap: 4px;
    }

    :deep(.n-button__state-border),
    :deep(.n-button__border),
    :deep(.n-button__ripple) {
        display: none;
    }
}

.toolbar-chevron {
    flex: 0 0 12px;
    color: $text-muted;
}

.attachment-previews {
    width: 100%;
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

.typing-dots {
    display: inline-flex;
    align-items: center;
    gap: 2px;

    span {
        display: block;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background-color: $text-muted;
        animation: typing-bounce 1.2s infinite;

        &:nth-child(2) { animation-delay: 0.2s; }
        &:nth-child(3) { animation-delay: 0.4s; }
    }
}

@keyframes typing-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-3px); opacity: 1; }
}

.input-wrapper {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    width: 100%;
    min-height: 150px;
    background-color: $bg-card;
    border: 1px solid $border-color;
    border-radius: 18px;
    padding: 14px 12px 9px;
    position: relative;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.08);
    transition: border-color $transition-fast, box-shadow $transition-fast;

    &:focus-within {
        border-color: rgba(var(--text-primary-rgb), 0.22);
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.11);
    }

    &.drag-over {
        border-color: $accent-primary;
        background-color: rgba(var(--accent-primary-rgb), 0.04);
    }

    .dark & {
        background-color: $bg-card;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
    }
}

.resize-handle {
    position: absolute;
    top: -4px;
    left: 0;
    right: 0;
    height: 8px;
    cursor: row-resize;
    z-index: 2;

    &:hover {
        background: rgba($accent-primary, 0.15);
        border-radius: 4px;
    }
}

.input-textarea {
    display: block;
    flex: 1;
    width: 100%;
    background: none;
    border: none;
    outline: none;
    color: $text-primary;
    font-family: $font-ui;
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    max-height: 400px;
    min-height: 24px;
    padding: 0;
    overflow-y: auto;

    @media (max-width: 768px) {
        font-size: 16px;
    }

    &::placeholder {
        color: $text-muted;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
}

.input-actions {
    display: flex;
    gap: 7px;
    flex-shrink: 0;
    align-items: center;
}

.input-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;
}

.toolbar-icon-button {
    color: $text-muted;
}

.send-button {
    width: 30px !important;
    min-width: 30px !important;
    height: 30px !important;
    padding: 0 !important;
    border: 0 !important;
    box-shadow: none !important;

    :deep(.n-button__icon) {
        margin: 0 !important;
    }

    :deep(.n-button__content) {
        display: none;
    }

    :deep(.n-button__border),
    :deep(.n-button__state-border),
    :deep(.n-button__ripple),
    :deep(.n-base-wave) {
        display: none;
    }

    &:disabled {
        color: var(--text-on-overlay);
        background-color: #9f9f9f;
        opacity: 1;
    }
}

.visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

@media (max-width: 768px) {
    .chat-input-area {
        padding: 8px 12px 12px;
    }

    .input-top-bar {
        gap: 5px;
    }

    .auto-play-speech-switch {
        display: none;
    }
}

/* ── Custom mention dropdown (replaces NDropdown) ── */

.mention-dropdown {
    position: fixed;
    background: $bg-card;
    border: 1px solid $border-color;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    min-width: 200px;
    max-height: 240px;
    overflow-y: auto;
    z-index: 9999;
    padding: 4px;
}

.mention-dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;

    &:hover,
    &.active {
        background: rgba(var(--text-primary-rgb), 0.08);
    }

    .mention-name {
        color: $text-primary;
        font-size: 14px;
        font-weight: 500;
    }

    .mention-profile {
        color: $text-muted;
        font-size: 12px;
    }

    &.mention-all-option .mention-name {
        color: $accent-primary;
        font-weight: 600;
    }
}

/* ── Dropdown fade/scale animation (matching NDropdown) ── */

.dropdown-fade-enter-active {
    transition: opacity 0.2s cubic-bezier(0, 0, .2, 1), transform 0.2s cubic-bezier(0, 0, .2, 1);
    transform-origin: top;
}
.dropdown-fade-leave-active {
    transition: opacity 0.2s cubic-bezier(.4, 0, 1, 1), transform 0.2s cubic-bezier(.4, 0, 1, 1);
    transform-origin: top;
}
.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
    opacity: 0;
    transform: scale(0.9);
}
.placement-top.dropdown-fade-enter-active,
.placement-top.dropdown-fade-leave-active {
    transform-origin: bottom;
}

@media (max-width: 768px) {
    .input-wrapper {
        min-height: 118px;
    }

    .input-settings-button {
        min-width: 36px;
        padding: 0 4px 0 6px;

        :deep(.n-button__content) {
            gap: 2px;
        }

        :deep(.n-button__icon) {
            margin: 0;
        }
    }

    .input-settings-label {
        display: none;
    }

    .input-textarea::placeholder {
        font-size: 13px;
        line-height: 1.35;
    }
}
</style>
