<script setup lang="ts">
import { onMounted } from 'vue'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()

onMounted(async () => {
  appStore.loadModels()
  // 先加载 profile，确保缓存 key 使用正确的 profile name；同时预取显示设置，
  // 让聊天完成提示音不依赖用户先打开 Settings 页面。
  await Promise.all([
    profilesStore.fetchProfiles(),
    settingsStore.fetchSettings(),
  ])
  chatStore.loadSessions()
})
</script>

<template>
  <div class="chat-view">
    <ChatPanel />
  </div>
</template>

<style scoped lang="scss">
.chat-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}
</style>
