<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import type { DropdownOption } from 'naive-ui'

const { t } = useI18n()
const emit = defineEmits<{ send: [content: string] }>()
const store = useGroupChatStore()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const isComposing = ref(false)

// ─── Mention State ───────────────────────────────────────

const mentionActive = ref(false)
const mentionQuery = ref('')
const mentionStartIndex = ref(-1)
const dropdownX = ref(0)
const dropdownY = ref(0)
const activeIndex = ref(0)

const filteredAgents = computed(() => {
    const query = mentionQuery.value.toLowerCase()
    return store.agents.filter(a => a.name.toLowerCase().includes(query))
})

const dropdownOptions = computed<DropdownOption[]>(() => {
    return filteredAgents.value.map((a, i) => ({
        label: `${a.name}  (${a.profile})`,
        key: a.name,
        index: i,
    }))
})

const canSend = computed(() => !!inputText.value.trim())

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
    dropdownY.value = rect.top - el.scrollTop - 8

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
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 100) + 'px'
        }
    })
}

// ─── Event Handlers ──────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
    // Mention navigation
    if (mentionActive.value && filteredAgents.value.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value + 1) % filteredAgents.value.length
            return
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value - 1 + filteredAgents.value.length) % filteredAgents.value.length
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

    nextTick(() => {
        if (textareaRef.value) {
            textareaRef.value.style.height = 'auto'
        }
    })
}

function handleInput(e: Event) {
    store.emitTyping()
    const el = e.target as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 100) + 'px'

    if (!isComposing.value) {
        updateMentionState()
    }
}

function handleDropdownSelect(key: string) {
    selectMention(key)
}

function handleDropdownClickOutside() {
    mentionActive.value = false
}

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
            <textarea
                ref="textareaRef"
                v-model="inputText"
                class="input-textarea"
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
        <NDropdown
            placement="top-start"
            trigger="manual"
            :x="dropdownX"
            :y="dropdownY"
            :options="dropdownOptions"
            :show="mentionActive"
            :render-icon="() => null"
            @select="handleDropdownSelect"
            @clickoutside="handleDropdownClickOutside"
        />
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
</style>
