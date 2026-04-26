<script setup lang="ts">
import { onMounted, watch } from 'vue'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()

// Guard against overlapping switchChatProfile calls
let _switchSeq = 0

onMounted(async () => {
  // Load settings first so busyInputMode is available immediately
  settingsStore.fetchSettings()
  appStore.loadModels()
  // 先加载 profile，确保缓存 key 使用正确的 profile name
  await profilesStore.fetchProfiles()
  chatStore.loadSessions()
  chatStore.updateAiAvatar()
  chatStore.loadUserAvatar()
})

// Profile 切换时保存当前状态并加载新 profile 的会话和模型列表
watch(
  () => profilesStore.activeProfileName,
  async (newName, oldName) => {
    if (newName && newName !== oldName) {
      const seq = ++_switchSeq
      // Pass oldName so switchChatProfile saves the old profile's state
      // under the correct key (activeProfileName is already changed by
      // the time this watcher fires).
      await chatStore.switchChatProfile(newName, oldName ?? undefined)
      // If another switch happened while we were loading, skip stale result
      if (seq !== _switchSeq) return
      // Re-fetch models from the new profile's gateway
      appStore.loadModels()
      // Update AI avatar for the new profile
      chatStore.updateAiAvatar()
    }
  },
)
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
