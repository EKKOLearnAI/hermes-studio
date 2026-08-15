<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import {
  getRoomDetail,
  getStoredUserId,
  type ChatMessage,
  type MemberInfo,
  type RoomAgent,
  type RoomInfo,
} from '@/api/hermes/group-chat'
import { groupAgentRunMessages } from '@/stores/hermes/group-chat'
import { useAppStore } from '@/stores/hermes/app'
import GroupAgentRunCard from '@/components/hermes/group-chat/GroupAgentRunCard.vue'
import GroupMessageItem from '@/components/hermes/group-chat/GroupMessageItem.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'

const PAGE_SIZE = 150
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const room = ref<RoomInfo | null>(null)
const messages = ref<ChatMessage[]>([])
const agents = ref<RoomAgent[]>([])
const members = ref<MemberInfo[]>([])
const loading = ref(false)
const error = ref('')
const showSidebar = ref(
  typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
)
const userId = getStoredUserId()

const roomId = computed(() => String(route.params.roomId || ''))
const displayMessages = computed(() => groupAgentRunMessages(messages.value))
const roomHref = computed(() => `#/hermes/group-chat/room/${encodeURIComponent(roomId.value)}`)

watch(showSidebar, expanded => appStore.setPageSidebarExpanded(expanded), { immediate: true })

async function loadCompleteHistory(): Promise<void> {
  if (!roomId.value || loading.value) return
  loading.value = true
  error.value = ''
  room.value = null
  messages.value = []
  try {
    let offset = 0
    let hasMore = true
    let nextMessages: ChatMessage[] = []
    const seen = new Set<string>()
    while (hasMore) {
      const page = await getRoomDetail(roomId.value, { offset, limit: PAGE_SIZE })
      if (offset === 0) {
        room.value = page.room
        agents.value = page.agents
        members.value = page.members
      }
      const uniquePage = page.messages.filter(message => {
        if (seen.has(message.id)) return false
        seen.add(message.id)
        return true
      })
      nextMessages = [...uniquePage, ...nextMessages]
      offset += page.messages.length
      hasMore = page.hasMore ?? offset < (page.total ?? offset)
      if (page.messages.length === 0) hasMore = false
    }
    messages.value = nextMessages
  } catch {
    error.value = t('groupChat.completeHistoryLoadFailed')
  } finally {
    loading.value = false
  }
}

function openPageSidebar() {
  showSidebar.value = true
}

function openNewChatPage() {
  void router.push({ name: 'hermes.chat' })
}

watch(roomId, () => {
  void loadCompleteHistory()
})

onMounted(() => {
  window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
  void loadCompleteHistory()
})

onUnmounted(() => {
  window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
})
</script>

<template>
  <div class="history-panel">
    <div class="session-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
    <aside class="session-list" :class="{ collapsed: !showSidebar }">
      <div v-if="showSidebar" class="page-sidebar-top">
        <PageSidebarNav
          active="history"
          :primary-label="t('chat.newChat')"
          hide-mode-switch
          @primary="openNewChatPage"
        />
        <div class="session-list-toolbar">
          <span class="session-list-title">{{ t('chat.hermesHistory') }}</span>
        </div>
      </div>
      <div v-if="showSidebar" class="group-history-sidebar">
        <a class="group-room-link" :href="roomHref">
          {{ room?.name || t('groupChat.completeHistory') }}
        </a>
        <span>{{ t('groupChat.readOnlyHistory') }}</span>
      </div>
      <PageSidebarFooter v-if="showSidebar" />
    </aside>

    <main class="chat-main" :class="{ 'chat-main--sidebar-collapsed': !showSidebar }">
      <header class="chat-header">
        <div class="header-left">
          <NButton class="history-sidebar-toggle" quaternary size="small" circle @click="showSidebar = !showSidebar">
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </template>
          </NButton>
          <h1>{{ room?.name || t('groupChat.completeHistory') }}</h1>
          <span class="source-badge">{{ t('groupChat.readOnlyHistory') }}</span>
        </div>
        <a class="group-history-back" :href="roomHref">{{ t('groupChat.backToRoom') }}</a>
      </header>

      <div v-if="loading" class="group-history-state" role="status">
        {{ t('groupChat.loadingCompleteHistory') }}
      </div>
      <div v-else-if="error" class="group-history-state group-history-error" role="alert">
        <span>{{ error }}</span>
        <button type="button" @click="loadCompleteHistory">{{ t('common.retry') }}</button>
      </div>
      <div v-else class="group-history-scroller" data-group-history-scroller>
        <section class="group-history-transcript" :aria-label="t('groupChat.completeHistory')">
          <div
            v-for="message in displayMessages"
            :key="message.id"
            class="group-history-message"
            :data-group-message-id="message.id"
          >
            <GroupAgentRunCard
              v-if="message.runItems?.length"
              :message="message"
              :agents="agents"
              :members="members"
              :current-user-id="userId"
              :allow-speech="false"
            />
            <GroupMessageItem
              v-else
              :message="message"
              :agents="agents"
              :members="members"
              :current-user-id="userId"
              :allow-speech="false"
            />
          </div>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.history-panel {
  display: flex;
  height: 100%;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: $bg-card;
}

.session-list {
  width: $sidebar-width;
  min-height: 0;
  align-self: stretch;
  margin: 10px;
  background: $bg-sidebar-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;

  &.collapsed {
    width: 0;
    margin-inline: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
  }
}

.page-sidebar-top {
  flex-shrink: 0;
  padding: 12px;
  border-bottom: 1px solid $border-color;
}

.session-list-toolbar {
  margin-top: 12px;
}

.session-list-title {
  color: $text-muted;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.group-history-sidebar {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 4px;
  padding: 12px;

  span {
    color: $text-muted;
    font-size: 12px;
  }
}

.group-room-link {
  color: $text-primary;
  font-weight: 600;
  text-decoration: none;
}

.chat-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin: 10px 10px 10px 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: $bg-main-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);

  &--sidebar-collapsed {
    margin-inline-start: 10px;
  }
}

.chat-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid $border-color;
}

.header-left {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;

  h1 {
    margin: 0;
    overflow: hidden;
    color: $text-primary;
    font-size: 16px;
    line-height: 28px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.source-badge {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 8px;
  background: rgba($text-muted, 0.12);
  color: $text-muted;
  font-size: 10px;
}

.group-history-back,
.group-history-state button {
  padding: 6px 10px;
  border: 1px solid $border-color;
  border-radius: 8px;
  background: $bg-secondary;
  color: $text-primary;
  cursor: pointer;
  text-decoration: none;
}

.group-history-state {
  display: flex;
  flex: 1;
  min-height: 0;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: $text-secondary;
}

.group-history-scroller {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.group-history-transcript {
  display: flex;
  width: min(920px, 100%);
  margin: 0 auto;
  box-sizing: border-box;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
}

.group-history-message {
  width: 100%;
}

.session-backdrop {
  display: none;
}

@media (max-width: $breakpoint-mobile) {
  .session-list {
    position: absolute;
    z-index: 120;
    inset: 10px auto 10px 10px;
    height: auto;
    margin: 0;

    &.collapsed {
      width: $sidebar-width;
      transform: translateX(calc(-100% - 10px));
    }
  }

  .session-backdrop {
    position: absolute;
    z-index: 110;
    inset: 0;
    display: block;
    background: rgba(0, 0, 0, 0.4);
    opacity: 0;
    pointer-events: none;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .chat-main {
    margin: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .history-sidebar-toggle {
    display: none;
  }

  .chat-header {
    padding: 14px 12px 14px 52px;
  }
}
</style>
