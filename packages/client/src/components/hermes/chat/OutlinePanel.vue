<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Message } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'

interface OutlineItem {
  id: string
  type: 'question' | 'answer'
  content: string
  messageId: string
  anchorId: string
}

const props = defineProps<{
  messages: Message[]
}>()

const chatStore = useChatStore()
const { t } = useI18n()

const sessionInfo = computed(() => {
  const s = chatStore.activeSession
  if (!s) return null
  return {
    messageCount: s.messageCount ?? s.messages.length,
    displayedCount: s.messages.length,
  }
})

const showLoadAll = computed(() => {
  const info = sessionInfo.value
  if (!info) return false
  return info.displayedCount < info.messageCount
})

async function handleLoadAll() {
  const sid = chatStore.activeSessionId
  if (!sid) return
  try {
    await chatStore.fetchAllMessages(sid)
  } catch (err) {
    console.error('Failed to load all messages:', err)
  }
}

function extractUserQuestion(text: string): string {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const firstLine = cleaned.split('\n')[0] || ''
  if (firstLine.length > 50) return firstLine.slice(0, 50) + '...'
  return firstLine || t('chat.outlineUserQuestion')
}

function extractAnswerSummary(text: string): string {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const lines = cleaned.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Skip empty lines, code blocks, markdown headings, blockquotes
    if (!trimmed || trimmed.startsWith('```') || trimmed.startsWith('#') || trimmed.startsWith('>')) continue
    if (trimmed.startsWith('| ') || trimmed.match(/^\|/)) continue
    if (trimmed.length > 80) return trimmed.slice(0, 80) + '...'
    return trimmed
  }
  return t('chat.outlineAnswer')
}

const outlineItems = computed<OutlineItem[]>(() => {
  const items: OutlineItem[] = []
  const filtered = props.messages.filter(m => m.role === 'user' || m.role === 'assistant')

  let i = 0
  while (i < filtered.length) {
    const msg = filtered[i]
    if (msg.role === 'user') {
      items.push({
        id: `question-${msg.id}`,
        type: 'question',
        content: extractUserQuestion(msg.content || ''),
        messageId: msg.id,
        anchorId: `message-${msg.id}`,
      })
      i++
      // Find the next assistant message
      while (i < filtered.length && filtered[i].role !== 'assistant') i++
      if (i < filtered.length) {
        const assistant = filtered[i]
        items.push({
          id: `answer-${assistant.id}`,
          type: 'answer',
          content: extractAnswerSummary(assistant.content || ''),
          messageId: assistant.id,
          anchorId: `message-${assistant.id}`,
        })
      }
    } else {
      i++
    }
  }
  return items
})

function scrollToTarget(anchorId: string) {
  nextTick(() => {
    const el = document.getElementById(anchorId)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  })
}
</script>

<template>
  <div class="outline-panel">
    <div class="outline-header">
      <span class="outline-title">{{ t('chat.outlineTitle') }}</span>
      <button
        v-if="showLoadAll"
        type="button"
        class="load-all-btn"
        :disabled="chatStore.isFetchingAllMessages"
        @click="handleLoadAll"
        :title="`${t('chat.loadAllMessages')} (${sessionInfo?.displayedCount}/${sessionInfo?.messageCount})`"
      >
        <svg
          v-if="chatStore.isFetchingAllMessages"
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
        <span>{{ chatStore.isFetchingAllMessages ? t('chat.loadingAllMessages') : `${t('chat.loadAllMessages')} (${sessionInfo?.displayedCount}/${sessionInfo?.messageCount})` }}</span>
      </button>
    </div>
    <div class="outline-content">
      <template v-if="outlineItems.length > 0">
        <div
          v-for="item in outlineItems"
          :key="item.id"
          class="outline-item"
          :class="item.type === 'question' ? 'question-item' : 'answer-item'"
          @click="scrollToTarget(item.anchorId)"
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
    color: $text-secondary;

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
</style>
