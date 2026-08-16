<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import {
  getRoomDetail,
  getStoredUserId,
  type ChatMessage,
  type MemberInfo,
  type RoomAgent,
  type RoomInfo,
} from '@/api/hermes/group-chat'
import { groupAgentRunMessages } from '@/stores/hermes/group-chat'
import { copyToClipboard } from '@/utils/clipboard'
import GroupAgentRunCard from './GroupAgentRunCard.vue'
import GroupMessageItem from './GroupMessageItem.vue'

const PAGE_SIZE = 150
const props = defineProps<{ roomId: string }>()
const emit = defineEmits<{ loaded: [room: RoomInfo | null] }>()
const router = useRouter()
const { t } = useI18n()
const toast = useMessage()
const room = ref<RoomInfo | null>(null)
const messages = ref<ChatMessage[]>([])
const agents = ref<RoomAgent[]>([])
const members = ref<MemberInfo[]>([])
const loading = ref(false)
const positioningInitial = ref(false)
const loadingOlder = ref(false)
const hasMoreBefore = ref(false)
const error = ref('')
const olderError = ref('')
const scroller = ref<HTMLElement | null>(null)
const userId = getStoredUserId()
let requestId = 0
let stopAnchorRestore: (() => void) | null = null

const displayMessages = computed(() => groupAgentRunMessages(messages.value))

async function scrollInitialPageToBottom(): Promise<void> {
  await nextTick()
  const element = scroller.value
  if (!element) return
  await new Promise<void>((resolve) => {
    const keepBottomUntil = Date.now() + 1000
    const keepBottom = () => {
      if (scroller.value !== element || Date.now() > keepBottomUntil) {
        if (scroller.value === element) element.scrollTop = element.scrollHeight
        resolve()
        return
      }
      element.scrollTop = element.scrollHeight
      requestAnimationFrame(keepBottom)
    }
    keepBottom()
  })
}

async function loadInitialHistory(): Promise<void> {
  const currentRequest = ++requestId
  if (!props.roomId) return
  loading.value = true
  error.value = ''
  olderError.value = ''
  room.value = null
  messages.value = []
  hasMoreBefore.value = false
  emit('loaded', null)
  try {
    const page = await getRoomDetail(props.roomId, { limit: PAGE_SIZE, history: true })
    if (currentRequest !== requestId) return
    room.value = page.room
    agents.value = page.agents
    members.value = page.members
    messages.value = page.messages
    hasMoreBefore.value = Boolean(page.hasMore)
    emit('loaded', page.room)
    positioningInitial.value = true
    loading.value = false
    await scrollInitialPageToBottom()
    if (currentRequest === requestId) positioningInitial.value = false
  } catch {
    if (currentRequest !== requestId) return
    error.value = t('groupChat.completeHistoryLoadFailed')
    positioningInitial.value = false
  } finally {
    if (currentRequest === requestId) loading.value = false
  }
}

async function loadOlderHistory(): Promise<void> {
  const element = scroller.value
  const before = messages.value[0]?.id
  const anchorId = displayMessages.value[0]?.id
  if (!element || !before || !anchorId || loadingOlder.value || !hasMoreBefore.value) return

  const anchor = element.querySelector<HTMLElement>(`[data-group-message-id="${CSS.escape(anchorId)}"]`)
  const anchorOffset = anchor
    ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
    : 0
  loadingOlder.value = true
  olderError.value = ''
  try {
    const page = await getRoomDetail(props.roomId, { before, limit: PAGE_SIZE, history: true })
    const existingIds = new Set(messages.value.map(item => item.id))
    messages.value = [...page.messages.filter(item => !existingIds.has(item.id)), ...messages.value]
    hasMoreBefore.value = Boolean(page.hasMore)
    await nextTick()
    if (scroller.value === element) {
      stopAnchorRestore?.()
      const keepAnchorUntil = Date.now() + 3000
      let active = true
      const stop = () => {
        active = false
        element.removeEventListener('wheel', stop)
        element.removeEventListener('touchstart', stop)
        element.removeEventListener('pointerdown', stop)
        if (stopAnchorRestore === stop) stopAnchorRestore = null
      }
      stopAnchorRestore = stop
      element.addEventListener('wheel', stop, { passive: true })
      element.addEventListener('touchstart', stop, { passive: true })
      element.addEventListener('pointerdown', stop, { passive: true })
      const keepAnchor = () => {
        if (!active || scroller.value !== element || Date.now() > keepAnchorUntil) {
          stop()
          return
        }
        const currentAnchor = element.querySelector<HTMLElement>(`[data-group-message-id="${CSS.escape(anchorId)}"]`)
        if (currentAnchor) {
          const currentOffset = currentAnchor.getBoundingClientRect().top - element.getBoundingClientRect().top
          element.scrollTop += currentOffset - anchorOffset
        }
        requestAnimationFrame(keepAnchor)
      }
      keepAnchor()
    }
  } catch {
    olderError.value = t('groupChat.earlierHistoryLoadFailed')
  } finally {
    loadingOlder.value = false
  }
}

function handleHistoryScroll(): void {
  if (olderError.value || (scroller.value?.scrollTop ?? 1) > 1) return
  void loadOlderHistory()
}

async function copyHistoryLink(): Promise<void> {
  const ok = await copyToClipboard(window.location.href)
  if (ok) toast.success(t('common.copied'))
}

watch(() => props.roomId, () => void loadInitialHistory(), { immediate: true })
onBeforeUnmount(() => stopAnchorRestore?.())
</script>

<template>
  <div class="group-history-pane">
    <header class="chat-header">
      <div class="header-left">
        <h1>{{ room?.name || t('groupChat.completeHistory') }}</h1>
        <span class="source-badge">{{ t('groupChat.readOnlyHistory') }}</span>
      </div>
      <div class="header-actions">
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton quaternary size="small" circle :aria-label="t('chat.copySessionLink')" @click="copyHistoryLink">
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </template>
            </NButton>
          </template>
          {{ t('chat.copySessionLink') }}
        </NTooltip>
        <a class="group-history-back" :href="router.resolve({ name: 'hermes.groupChatRoom', params: { roomId: props.roomId } }).href">
          {{ t('groupChat.backToRoom') }}
        </a>
      </div>
    </header>

    <div v-if="loading" class="group-history-state" role="status">{{ t('groupChat.loadingCompleteHistory') }}</div>
    <div v-else-if="error" class="group-history-state group-history-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="loadInitialHistory">{{ t('common.retry') }}</button>
    </div>
    <div
      v-else
      ref="scroller"
      class="group-history-scroller"
      :class="{ 'group-history-scroller--positioning': positioningInitial }"
      data-group-history-scroller
      @scroll="handleHistoryScroll"
    >
      <div class="group-history-page-state" aria-live="polite">
        <span v-if="loadingOlder" role="status">{{ t('groupChat.loadingEarlierHistory') }}</span>
        <template v-else-if="olderError">
          <span role="alert">{{ olderError }}</span>
          <button type="button" @click="loadOlderHistory">{{ t('groupChat.retryEarlierHistory') }}</button>
        </template>
        <span v-else-if="!hasMoreBefore">{{ t('groupChat.earliestHistoryReached') }}</span>
      </div>
      <section class="group-history-transcript" :aria-label="t('groupChat.completeHistory')">
        <div v-for="item in displayMessages" :key="item.id" class="group-history-message" :data-group-message-id="item.id">
          <GroupAgentRunCard v-if="item.runItems?.length" :message="item" :agents="agents" :members="members" :current-user-id="userId" :allow-speech="false" />
          <GroupMessageItem v-else :message="item" :agents="agents" :members="members" :current-user-id="userId" :allow-speech="false" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.group-history-pane { display: flex; flex: 1; min-height: 0; flex-direction: column; overflow: hidden; }
.chat-header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid $border-color; }
.header-left, .header-actions { display: flex; min-width: 0; align-items: center; gap: 8px; }
h1 { margin: 0; overflow: hidden; color: $text-primary; font-size: 16px; line-height: 28px; text-overflow: ellipsis; white-space: nowrap; }
.source-badge { flex-shrink: 0; padding: 1px 7px; border-radius: 8px; background: rgba($text-muted, 0.12); color: $text-muted; font-size: 10px; }
.group-history-back { padding: 6px 10px; border-radius: 8px; color: $text-primary; text-decoration: none; }
.group-history-back:hover { background: rgba($accent-primary, 0.08); }
.group-history-state { display: flex; flex: 1; min-height: 0; align-items: center; justify-content: center; gap: 10px; color: $text-secondary; }
.group-history-state button, .group-history-page-state button { padding: 6px 10px; border: 1px solid $border-color; border-radius: 8px; background: $bg-secondary; color: $text-primary; cursor: pointer; }
.group-history-page-state { display: flex; min-height: 36px; align-items: center; justify-content: center; gap: 8px; padding: 8px 20px 0; color: $text-muted; font-size: 12px; }
.group-history-scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.group-history-scroller--positioning { visibility: hidden; }
.group-history-transcript { display: flex; width: min(920px, 100%); margin: 0 auto; box-sizing: border-box; flex-direction: column; gap: 12px; padding: 20px; }
.group-history-message { width: 100%; }
@media (max-width: $breakpoint-mobile) { .chat-header { padding: 14px 12px 14px 52px; } }
</style>
