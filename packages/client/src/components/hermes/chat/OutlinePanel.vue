<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Message } from '@/stores/hermes/chat'

interface OutlineItem {
  id: string
  type: 'outline'
  content: string
  messageId: string
  level: number
  anchorId: string
}

interface OutlineGroup {
  id: string
  messageId: string
  content: string
  anchorId: string
  headings: OutlineItem[]
}

const props = defineProps<{
  messages: Message[]
}>()

const emit = defineEmits<{
  navigate: [target: { messageId: string; anchorId: string }]
}>()

const { t } = useI18n()

function extractAllHeadings(text: string, messageId: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const lines = cleanedText.split('\n')
  
  let headingIndex = 0
  for (const line of lines) {
    const trimmed = line.trim()
    const h1Match = trimmed.match(/^#\s+(.+)/)
    const h2Match = trimmed.match(/^##\s+(.+)/)
    const h3Match = trimmed.match(/^###\s+(.+)/)
    
    if (h1Match) {
      headingIndex++
      items.push({
        id: `outline-${messageId}-h${headingIndex}`,
        type: 'outline',
        content: h1Match[1].trim(),
        messageId,
        level: 1,
        anchorId: `msg-${messageId}-heading-${headingIndex}`
      })
    } else if (h2Match) {
      headingIndex++
      items.push({
        id: `outline-${messageId}-h${headingIndex}`,
        type: 'outline',
        content: h2Match[1].trim(),
        messageId,
        level: 2,
        anchorId: `msg-${messageId}-heading-${headingIndex}`
      })
    } else if (h3Match) {
      headingIndex++
      items.push({
        id: `outline-${messageId}-h${headingIndex}`,
        type: 'outline',
        content: h3Match[1].trim(),
        messageId,
        level: 3,
        anchorId: `msg-${messageId}-heading-${headingIndex}`
      })
    }
  }
  
  return items
}

function extractUserQuestion(text: string): string {
  const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const firstLine = cleanedText.split('\n')[0] || ''
  if (firstLine.length > 50) {
    return firstLine.slice(0, 50) + '...'
  }
  return firstLine || t('chat.outlineUserQuestion')
}

const outlineGroups = computed<OutlineGroup[]>(() => {
  const groups: OutlineGroup[] = []
  let i = 0
  const filteredMessages = props.messages.filter(m => m.role === 'user' || m.role === 'assistant')
  
  while (i < filteredMessages.length) {
    const msg = filteredMessages[i]
    if (msg.role === 'user') {
      const group: OutlineGroup = {
        id: `user-${msg.id}`,
        messageId: msg.id,
        content: extractUserQuestion(msg.content || ''),
        anchorId: `message-${msg.id}`,
        headings: []
      }
      
      i++
      while (i < filteredMessages.length && filteredMessages[i].role !== 'assistant') {
        i++
      }
      if (i < filteredMessages.length) {
        const assistantMsg = filteredMessages[i]
        group.headings = extractAllHeadings(assistantMsg.content || '', assistantMsg.id)
      }
      groups.push(group)
    } else {
      i++
    }
  }
  return groups
})

const collapsedGroups = ref<Set<string>>(new Set())

function toggleGroup(messageId: string, event: Event) {
  event.stopPropagation()
  const newSet = new Set(collapsedGroups.value)
  if (newSet.has(messageId)) {
    newSet.delete(messageId)
  } else {
    newSet.add(messageId)
  }
  collapsedGroups.value = newSet
}

function scrollToTarget(messageId: string, anchorId: string) {
  emit('navigate', { messageId, anchorId })
}
</script>

<template>
  <div class="outline-panel">
    <div class="outline-header">
      <span class="outline-title">{{ t('chat.outlineTitle') }}</span>
    </div>
    <div class="outline-content">
      <template v-if="outlineGroups.length > 0">
        <div v-for="group in outlineGroups" :key="group.id" class="outline-group">
          <div
            class="outline-item user-item"
            @click="scrollToTarget(group.messageId, group.anchorId)"
          >
            <div class="user-question">
              <span class="chevron" 
                    :class="{ 'is-collapsed': collapsedGroups.has(group.messageId) }" 
                    @click="toggleGroup(group.messageId, $event)"
                    v-if="group.headings.length > 0">
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6l-6-6l1.41-1.41z"/></svg>
              </span>
              <span class="q-label">Q:</span>
              <span class="q-text">{{ group.content }}</span>
            </div>
          </div>
          <div v-show="!collapsedGroups.has(group.messageId)" class="outline-group-headings">
            <div
              v-for="item in group.headings"
              :key="item.id"
              class="outline-item outline-heading-item"
              :class="'level-' + item.level"
              @click="scrollToTarget(item.messageId, item.anchorId)"
            >
              <div class="heading-item">
                <span class="heading-text">{{ item.content }}</span>
              </div>
            </div>
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
}

.outline-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.outline-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.outline-group {
  margin-bottom: 8px;
}

.outline-item {
  margin-bottom: 4px;
  cursor: pointer;
  transition: opacity 0.2s ease;

  &:hover {
    opacity: 0.8;
  }
}

.user-item {
  margin-bottom: 6px;
}

.user-question {
  background-color: $bg-secondary;
  color: $text-primary;
  padding: 8px 12px;
  border-radius: 8px;
  display: flex;
  align-items: flex-start;
  gap: 6px;

  .dark & {
    background-color: $bg-input;
  }

  .chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.2s ease;
    margin-top: 1px;
    padding: 2px;
    border-radius: 4px;
    
    &:hover {
      background-color: rgba(0, 0, 0, 0.1);
      .dark & {
        background-color: rgba(255, 255, 255, 0.1);
      }
    }

    &.is-collapsed {
      transform: rotate(-90deg);
    }
  }

  .q-label {
    font-weight: 600;
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1.4;
  }

  .q-text {
    font-size: 13px;
    line-height: 1.4;
    word-break: break-word;
  }
}

.outline-heading-item {
  &.level-1 {
    padding-left: 0;
  }

  &.level-2 {
    padding-left: 12px;
  }

  &.level-3 {
    padding-left: 24px;
  }
}

.heading-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background-color 0.15s ease;

  &:hover {
    background-color: rgba(0, 0, 0, 0.04);

    .dark & {
      background-color: rgba(255, 255, 255, 0.06);
    }
  }

  .level-1 & {
    .heading-text {
      color: $text-primary;
      font-weight: 500;
    }
  }

  .level-2 & {
    .heading-text {
      color: $text-secondary;
    }
  }

  .level-3 & {
    .heading-text {
      color: $text-muted;
      font-size: 12px;
    }
  }
}

.heading-text {
  font-size: 13px;
  line-height: 1.4;
  word-break: break-word;
}

.outline-empty {
  text-align: center;
  color: $text-muted;
  font-size: 13px;
  padding: 20px 0;
}
</style>


