<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getDownloadUrl } from '@/api/studio/download'
import { useChatAnnotationsStore } from '@/stores/hermes/chat-annotations'
import type { ResponseAnnotation, ResponseAnnotationFile } from '@/utils/chat-response-annotations'

const props = defineProps<{
  sessionId: string
  messageId: string
  annotations: ResponseAnnotation[]
}>()

const { t } = useI18n()
const annotationsStore = useChatAnnotationsStore()
const expanded = ref(false)
const chip = ref<HTMLElement | null>(null)
const cardPosition = ref({ left: 8, top: 8 })
const unavailableAnnotationId = ref<string | null>(null)

const countLabel = computed(() => t(
  props.annotations.length === 1 ? 'chat.annotations.countOne' : 'chat.annotations.countMany',
  { count: props.annotations.length },
))

function updateCardPosition() {
  const rect = chip.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(448, window.innerWidth - 16)
  const estimatedHeight = Math.min(448, 160 * props.annotations.length)
  const above = rect.top - estimatedHeight - 8
  cardPosition.value = {
    left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    top: Math.max(8, above >= 8 ? above : Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 8)),
  }
}

function toggleExpanded() {
  expanded.value = !expanded.value
  unavailableAnnotationId.value = null
  if (expanded.value) {
    annotationsStore.inspectSentAnnotations(props.sessionId, props.messageId, props.annotations)
    void nextTick(updateCardPosition)
  } else {
    annotationsStore.clearInspectedSentAnnotations(props.messageId)
  }
}

function showSource(annotation: ResponseAnnotation) {
  const event = new CustomEvent('hermes:show-response-annotation-source', {
    cancelable: true,
    detail: { annotation },
  })
  window.dispatchEvent(event)
  unavailableAnnotationId.value = event.defaultPrevented ? null : annotation.id
}

function fileUrl(file: ResponseAnnotationFile) {
  return file.path ? getDownloadUrl(file.path, file.name) : ''
}

function isImage(file: ResponseAnnotationFile) {
  return file.type.startsWith('image/')
}

function handleDocumentClick(event: MouseEvent) {
  if (!expanded.value) return
  const target = event.target as Node
  const card = document.querySelector('[data-testid="response-annotation-sent-card"]')
  if (chip.value?.contains(target) || card?.contains(target)) return
  expanded.value = false
  annotationsStore.clearInspectedSentAnnotations(props.messageId)
}

function handleKeydown(event: KeyboardEvent) {
  if (!expanded.value || event.key !== 'Escape') return
  event.preventDefault()
  expanded.value = false
  annotationsStore.clearInspectedSentAnnotations(props.messageId)
  chip.value?.querySelector('button')?.focus()
}

document.addEventListener('click', handleDocumentClick)
document.addEventListener('keydown', handleKeydown)
window.addEventListener('resize', updateCardPosition)
document.addEventListener('scroll', updateCardPosition, true)

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', updateCardPosition)
  document.removeEventListener('scroll', updateCardPosition, true)
  annotationsStore.clearInspectedSentAnnotations(props.messageId)
})
</script>

<template>
  <div v-if="annotations.length" ref="chip" class="sent-response-annotations" data-annotation-ignore>
    <button
      type="button"
      class="sent-annotation-chip"
      data-testid="response-annotation-count"
      :aria-expanded="expanded"
      @click="toggleExpanded"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>
      <span>{{ countLabel }}</span>
      <svg class="sent-annotation-chevron" :class="{ expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
  </div>

  <Teleport to="body">
    <ol
      v-if="expanded"
      class="sent-annotation-card"
      data-testid="response-annotation-sent-card"
      :style="{ left: `${cardPosition.left}px`, top: `${cardPosition.top}px` }"
      data-annotation-ignore
    >
      <li v-for="annotation in annotations" :key="annotation.id">
        <p class="sent-annotation-label">{{ annotation.ordinal }}. {{ t('chat.annotations.selectedExcerpt') }}</p>
        <blockquote>{{ annotation.selectedText }}</blockquote>
        <template v-if="annotation.comment">
          <div class="sent-annotation-divider" />
          <p class="sent-annotation-label">{{ t('chat.annotations.yourComment') }}</p>
          <p class="sent-annotation-comment">{{ annotation.comment }}</p>
        </template>
        <div v-if="annotation.files.length" class="sent-annotation-files">
          <a
            v-for="file in annotation.files"
            :key="file.id"
            :href="fileUrl(file)"
            target="_blank"
            rel="noopener noreferrer"
            :class="{ image: isImage(file) }"
          >
            <img v-if="isImage(file) && fileUrl(file)" :src="fileUrl(file)" :alt="file.name" />
            <span>📎 {{ file.name }}</span>
          </a>
        </div>
        <button type="button" class="show-source" @click="showSource(annotation)">
          {{ t('chat.annotations.showSource') }}
        </button>
        <p v-if="unavailableAnnotationId === annotation.id" role="status" class="source-unavailable">
          {{ t('chat.annotations.sourceUnavailable') }}
        </p>
      </li>
    </ol>
  </Teleport>
</template>

<style scoped lang="scss">
.sent-response-annotations {
  align-self: flex-start;
  margin-bottom: 6px;
}

.sent-annotation-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--bg-card-hover);
  box-shadow: 0 7px 18px rgba(0, 0, 0, 0.14);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sent-annotation-chip:hover,
.sent-annotation-chip:focus-visible {
  color: var(--text-primary);
  background: var(--bg-card);
  outline: none;
}

.sent-annotation-chevron {
  transition: transform 160ms ease;
}

.sent-annotation-chevron.expanded {
  transform: rotate(180deg);
}

.sent-annotation-card {
  position: fixed;
  z-index: 1001;
  width: min(448px, calc(100vw - 16px));
  max-height: min(448px, calc(100vh - 16px));
  overflow: auto;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: 18px;
  background: var(--bg-card);
  box-shadow: 0 24px 56px rgba(0, 0, 0, 0.34);
  list-style: none;
}

.sent-annotation-card li {
  padding: 16px;
}

.sent-annotation-card li + li {
  border-top: 1px solid var(--border-light);
}

.sent-annotation-label {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 650;
}

blockquote {
  margin: 8px 0 0;
  padding: 9px 12px;
  border-inline-start: 3px solid var(--success);
  color: var(--text-primary);
  background: rgba(var(--success-rgb), 0.08);
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.55;
}

.sent-annotation-divider {
  margin: 12px 0;
  border-top: 1px solid var(--border-light);
}

.sent-annotation-comment {
  margin: 5px 0 0;
  color: var(--text-primary);
  white-space: pre-wrap;
  font-size: 13px;
}

.sent-annotation-files {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}

.sent-annotation-files a {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  max-width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  color: var(--text-secondary);
  background: var(--bg-card-hover);
  text-decoration: none;
  font-size: 11px;
}

.sent-annotation-files img {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
}

.show-source {
  min-height: 32px;
  margin-top: 10px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  color: var(--text-secondary);
  background: transparent;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.show-source:hover,
.show-source:focus-visible {
  color: var(--text-primary);
  background: var(--bg-card-hover);
  outline: none;
}

.source-unavailable {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 11px;
}

@media (pointer: coarse) {
  .sent-annotation-chip,
  .show-source {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sent-annotation-chevron {
    transition: none;
  }
}
</style>
