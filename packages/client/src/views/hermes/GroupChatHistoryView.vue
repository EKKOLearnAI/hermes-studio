<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  getRoomDetail,
  getStoredUserId,
  type ChatMessage,
  type MemberInfo,
  type RoomAgent,
  type RoomInfo,
} from '@/api/hermes/group-chat'
import { groupAgentRunMessages } from '@/stores/hermes/group-chat'
import GroupAgentRunCard from '@/components/hermes/group-chat/GroupAgentRunCard.vue'
import GroupMessageItem from '@/components/hermes/group-chat/GroupMessageItem.vue'

const PAGE_SIZE = 150
const route = useRoute()
const { t } = useI18n()
const room = ref<RoomInfo | null>(null)
const messages = ref<ChatMessage[]>([])
const agents = ref<RoomAgent[]>([])
const members = ref<MemberInfo[]>([])
const loading = ref(false)
const error = ref('')
const userId = getStoredUserId()

const roomId = computed(() => String(route.params.roomId || ''))
const displayMessages = computed(() => groupAgentRunMessages(messages.value))
const roomHref = computed(() => `#/hermes/group-chat/room/${encodeURIComponent(roomId.value)}`)

async function loadCompleteHistory(): Promise<void> {
  if (!roomId.value || loading.value) return
  loading.value = true
  error.value = ''
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
  } catch (err: any) {
    error.value = err?.message || t('groupChat.completeHistoryLoadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadCompleteHistory()
})
</script>

<template>
  <main class="group-history-view">
    <header class="group-history-header">
      <a class="group-history-back" :href="roomHref">{{ t('groupChat.backToRoom') }}</a>
      <div>
        <h1>{{ room?.name || t('groupChat.completeHistory') }}</h1>
        <p>{{ t('groupChat.readOnlyHistory') }}</p>
      </div>
    </header>

    <div v-if="loading" class="group-history-state" role="status">
      {{ t('groupChat.loadingCompleteHistory') }}
    </div>
    <div v-else-if="error" class="group-history-state group-history-error" role="alert">
      <span>{{ t('groupChat.completeHistoryLoadFailed') }}</span>
      <button type="button" @click="loadCompleteHistory">{{ t('common.retry') }}</button>
    </div>
    <section v-else class="group-history-transcript" :aria-label="t('groupChat.completeHistory')">
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
  </main>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-history-view {
  min-height: calc(100 * var(--vh));
  background: $bg-primary;
  color: $text-primary;
}

.group-history-header {
  position: sticky;
  z-index: 2;
  top: 0;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid $border-color;
  background: color-mix(in srgb, #{$bg-primary} 94%, transparent);
  backdrop-filter: blur(12px);

  h1,
  p {
    margin: 0;
  }

  h1 {
    font-size: 18px;
  }

  p {
    margin-top: 2px;
    color: $text-secondary;
    font-size: 12px;
  }
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
  min-height: 240px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: $text-secondary;
}

.group-history-transcript {
  display: flex;
  width: min(920px, 100%);
  margin: 0 auto;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
}

.group-history-message {
  width: 100%;
}
</style>
