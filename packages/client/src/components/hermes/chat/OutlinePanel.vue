<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NTooltip } from 'naive-ui'
import type { Message } from '@/stores/hermes/chat'
import { mapHermesMessages } from '@/stores/hermes/chat'
import { fetchHermesSession } from '@/api/hermes/sessions'

interface OutlineItem {
  id: string
  type: 'question' | 'answer'
  content: string
  messageId: string
  anchorId: string
}

const props = defineProps<{
  messages: Message[]
  sessionId?: string
  sessionProfile?: string | null
  showLoadAll?: boolean
}>()

const emit = defineEmits<{
  navigate: [target: { messageId: string; anchorId: string }]
  messagesLoaded: [messages: Message[]]
}>()

const { t } = useI18n()
const localFetching = ref(false)

async function handleLoadAll() {
  if (!props.sessionId) return

  localFetching.value = true
  try {
    const sessionDetail = await fetchHermesSession(props.sessionId, props.sessionProfile)
    if (sessionDetail && sessionDetail.messages) {
      const mapped = mapHermesMessages(sessionDetail.messages)
      emit('messagesLoaded', mapped)
    }
  } finally {
    localFetching.value = false
  }
}

function extractUserQuestion(text: string): string {
  const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const firstLine = cleanedText.split('\n')[0] || ''
  if (firstLine.length > 50) return firstLine.slice(0, 50) + '...'
  return firstLine || t('chat.outlineUserQuestion')
}

function extractAnswerSummary(text: string): string | null {
  const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const lines = cleanedText.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('```') || trimmed.startsWith('#') || trimmed.startsWith('>')) continue
    if (trimmed.startsWith('| ') || trimmed.match(/^\|/)) continue
    if (trimmed.length > 80) return trimmed.slice(0, 80) + '...'
    return trimmed
  }
  return null
}

const outlineItems = computed<OutlineItem[]>(() => {
  const items: OutlineItem[] = []
  // Find first user message to skip leading system/command init messages
  const firstUserIdx = props.messages.findIndex(m =>
    m.role === 'user' || (m.role === 'command' && m.systemType === 'command')
  )
  const visibleMessages = props.messages.slice(Math.max(0, firstUserIdx))
  // Only include user and assistant messages for outline
  const filteredMessages = visibleMessages.filter(m =>
    m.role === 'user' || m.role === 'assistant' || (m.role === 'command' && m.systemType === 'command')
  )

  let i = 0
  while (i < filteredMessages.length) {
    const msg = filteredMessages[i]
    if (msg.role === 'user' || msg.role === 'command') {
      items.push({
        id: `question-${msg.id}`,
        type: 'question',
        content: extractUserQuestion(msg.content || ''),
        messageId: msg.id,
        anchorId: `message-${msg.id}`,
      })
      i++
      while (i < filteredMessages.length && filteredMessages[i].role !== 'assistant') i++
      if (i < filteredMessages.length) {
        const assistant = filteredMessages[i]
        const summary = extractAnswerSummary(assistant.content || '')
        if (summary !== null) {
          items.push({
            id: `answer-${assistant.id}`,
            type: 'answer',
            content: summary,
            messageId: assistant.id,
            anchorId: `message-${assistant.id}`,
          })
        }
      }
    } else {
      i++
    }
  }
  return items
})

function scrollToTarget(item: OutlineItem) {
  emit('navigate', {
    messageId: item.messageId,
    anchorId: item.anchorId,
  })
}
</script>

<template>
  <div class="outline-panel">
    <div class="outline-header">
      <span class="outline-title">{{ t('chat.outlineTitle') }}</span>
      <NTooltip v-if="showLoadAll" trigger="hover" placement="top">
        <template #trigger>
          <button
            type="button"
            class="load-all-btn"
            :disabled="localFetching"
            @click="handleLoadAll"
          >
            <svg
              v-if="localFetching"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="load-all-spinner"
            >
              <path d="M21 12a9 9 0 11-6.219-8.56" />
            </svg>
            <svg
              v-else
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </template>
        {{ t('chat.loadAllMessages') }}
      </NTooltip>
    </div>
    <div class="outline-content">
      <template v-if="outlineItems.length > 0">
        <div
          v-for="item in outlineItems"
          :key="item.id"
          class="outline-item"
          :class="item.type === 'question' ? 'question-item' : 'answer-item'"
          @click="scrollToTarget(item)"
        >
          <div class="outline-text">
            <span class="outline-label">{{ item.type === 'question' ? 'Q' : 'A' }}:</span>
            <span class="outline-content">{{ item.content }}</span>
          </div>
        </div>
      </template>
      <div v-else class="outline-empty">{{ t('chat.outlineEmpty') }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.outline-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: $bg-card;
  border-left: 1px solid $border-color;
  width: 280px;
  flex-shrink: 0;

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(280px, 86vw);
    z-index: 8;
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
  }
}

.outline-header {
  padding: 16px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.outline-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.outline-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.outline-item {
  margin-bottom: 6px;
  cursor: pointer;
  transition: opacity 0.2s ease;

  &:hover {
    opacity: 0.8;
  }
}

.outline-text {
  padding: 6px 10px;
  border-radius: 6px;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;

  .outline-label {
    font-weight: 600;
    flex-shrink: 0;
  }

  .outline-content {
    word-break: break-word;
  }
}

.question-item {
  .outline-text {
    background-color: $bg-secondary;
    color: $text-primary;

    .dark & {
      background-color: $bg-input;
    }

    .outline-label {
      color: #3b82f6;
    }
  }
}

.answer-item {
  margin-top: 2px;
  .outline-text {
    background-color: rgba(34, 197, 94, 0.08);
    color: $text-secondary;

    .dark & {
      background-color: rgba(34, 197, 94, 0.12);
    }

    .outline-label {
      color: #22c55e;
    }
  }
}

.outline-empty {
  text-align: center;
  color: $text-muted;
  font-size: 13px;
  padding: 20px 0;
}

.load-all-btn {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  color: $text-muted;
  background: transparent;
  transition: all 0.15s ease;
  white-space: nowrap;

  &:hover {
    color: $text-primary;
    background: $bg-secondary;

    .dark & {
      background: $bg-input;
    }
  }

  &:active {
    opacity: 0.7;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.load-all-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
