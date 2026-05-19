<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

const { t } = useI18n()
const emit = defineEmits<{ send: [content: string] }>()
const store = useGroupChatStore()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const dropdownRef = ref<HTMLDivElement>()
const isComposing = ref(false)

// 自定义高度拖拽
const textareaHeight = ref<number | null>(null)

function startResize(e: MouseEvent) {
  e.preventDefault()
  const el = textareaRef.value
  if (!el) return
  const startHeight = el.clientHeight
  const startY = e.clientY

  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    const newHeight = startHeight - deltaY
    textareaHeight.value = Math.max(20, Math.min(400, Math.round(newHeight)))
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

const filteredAgents = computed(() => {
    const query = mentionQuery.value.toLowerCase()
    return store.agents.filter(a => a.name.toLowerCase().includes(query))
})

const canSend = computed(() => !!inputText.value.trim())

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
    const estimatedHeight = Math.min(filteredAgents.value.length * 36 + 8, 240)
    const spaceBelow = window.innerHeight - rect.top + el.scrollTop - 8
    if (spaceBelow < estimatedHeight && rect.top - el.scrollTop - 8 > estimatedHeight) {
        placement.value = 'top'
        dropdownY.value = rect.top - el.scrollTop - 8
    } else {
        placement.value = 'bottom'
        dropdownY.value = rect.top - el.scrollTop - 8
    }

    dropdownBottom.value = window.innerHeight - dropdownY.value

    mentionActive.value = filteredAgents.value.length > 0
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
            if (textareaHeight.value === null) {
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 100) + 'px'
            }
        }
    })
}

// ─── Event Handlers ──────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
    // Mention navigation — fully custom, no NDropdown interference
    if (mentionActive.value && filteredAgents.value.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value + 1) % filteredAgents.value.length
            scrollToActive()
            return
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value - 1 + filteredAgents.value.length) % filteredAgents.value.length
            scrollToActive()
            return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            selectMention(filteredAgents.value[activeIndex.value].name)
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
    if (!content) return

    emit('send', content)
    inputText.value = ''
    mentionActive.value = false
    // 发送后重置到自定义高度（不清除拖拽状态）
}

function handleInput(e: Event) {
    // 用户手动拖拽自定义高度时，不覆盖
    if (textareaHeight.value !== null) return
    store.emitTyping()
    const el = e.target as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 100) + 'px'

    if (!isComposing.value) {
        updateMentionState()
    }
}

function handleMentionClick(name: string) {
    selectMention(name)
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
</script>

<template>
    <div class="chat-input-area">
        <div class="input-wrapper">
            <div class="resize-handle" @mousedown="startResize"></div>
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
            />
            <div class="input-actions">
                <NButton
                    size="small"
                    type="primary"
                    :disabled="!canSend"
                    @click="handleSend"
                >
                    <template #icon>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                    </template>
                    {{ t('chat.send') }}
                </NButton>
            </div>
        </div>
        <Transition name="dropdown-fade">
            <div
                v-if="mentionActive && filteredAgents.length > 0"
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
                    v-for="(agent, i) in filteredAgents"
                    :key="agent.name"
                    class="mention-dropdown-item"
                    :class="{ active: i === activeIndex }"
                    @mousedown.prevent="handleMentionClick(agent.name)"
                    @mouseenter="handleMentionHover(i)"
                >
                    <span class="mention-name">@{{ agent.name }}</span>
                    <span class="mention-profile">{{ agent.profile }}</span>
                </div>
            </div>
        </Transition>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.chat-input-area {
    padding: 20px 20px 16px;
    border-top: 1px solid $border-color;
    flex-shrink: 0;
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
    align-items: center;
    gap: 10px;
    background-color: $bg-input;
    border: 1px solid $border-color;
    border-radius: $radius-md;
    padding: 10px 12px;
    position: relative;
    transition: border-color $transition-fast, background-color $transition-fast;

    &:focus-within {
        border-color: $accent-primary;
    }

    .dark & {
        background-color: #333333;
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
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: $text-primary;
    font-family: $font-ui;
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    max-height: 400px;
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
</style>
