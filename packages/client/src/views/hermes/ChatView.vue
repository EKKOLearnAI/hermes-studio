<script setup lang="ts">
import { onMounted } from 'vue'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import ApprovalDialog from '@/components/hermes/chat/ApprovalDialog.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'

const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()

onMounted(async () => {
  appStore.loadModels()
  // 先加载 profile，确保缓存 key 使用正确的 profile name
  await profilesStore.fetchProfiles()
  chatStore.loadSessions()
})
</script>

<template>
  <div class="chat-view">
    <ChatPanel />
    <ApprovalDialog />
  </div>
</template>

<style scoped lang="scss">
.chat-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}
</style>
