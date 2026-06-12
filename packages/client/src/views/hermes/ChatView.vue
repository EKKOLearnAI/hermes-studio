<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import TerminalPanel from '@/components/hermes/chat/TerminalPanel.vue'

const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const route = useRoute()
const router = useRouter()

const routeSessionId = computed(() => {
  const value = route.params.sessionId
  return typeof value === 'string' && value.trim() ? value : null
})

const routeProfile = computed(() => {
  const value = route.query.profile
  return typeof value === 'string' && value.trim() ? value : null
})

const terminalVisible = ref(false)
function toggleTerminal() { terminalVisible.value = !terminalVisible.value }
function handleKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.code === 'Backquote') { e.preventDefault(); toggleTerminal() }
}

const productTitle = 'Hermes Studio'
const tabTitle = computed(() => {
  if (route.name !== 'hermes.session') return productTitle
  return chatStore.activeSession?.title?.trim() || productTitle
})

watch(tabTitle, (value) => {
  document.title = value
}, { immediate: true })

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.title = productTitle
})

async function loadRouteSession() {
  await chatStore.loadSessions(chatStore.sessionProfileFilter, routeSessionId.value)
  if (routeSessionId.value && chatStore.activeSessionId !== routeSessionId.value) {
    await router.replace({ name: 'hermes.chat' })
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  appStore.loadModels()
  // 先加载 profile，确保缓存 key 使用正确的 profile name；同时预取显示设置，
  // 让聊天完成提示音不依赖用户先打开 Settings 页面。
  await Promise.all([
    profilesStore.fetchProfiles(),
    settingsStore.fetchSettings(),
  ])
  await loadRouteSession()
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (!chatStore.sessionsLoaded) return
  if (!sessionId) {
    await chatStore.loadSessions(chatStore.sessionProfileFilter)
    return
  }
  if (chatStore.activeSessionId === sessionId) return

  const exists = chatStore.sessions.some(session => session.id === sessionId)
  if (!exists) {
    await loadRouteSession()
    return
  }

  await chatStore.switchSession(sessionId)
})
</script>

<template>
  <div class="chat-view">
    <div class="chat-area">
    <ChatPanel />
    </div>
    <TerminalPanel v-model:visible="terminalVisible" />
    <button class="terminal-toggle" :class="{ active: terminalVisible }" title="Toggle Terminal (Ctrl+`)" @click="toggleTerminal">_ terminal</button>
  </div>
</template>

<style scoped lang="scss">
.chat-view { height: calc(100 * var(--vh)); display: flex; flex-direction: column; }
.chat-area { flex: 1; min-height: 0; overflow: hidden; }
.terminal-toggle { position: fixed; bottom: 12px; right: 12px; z-index: 100; padding: 6px 14px; font-size: 12px; font-family: monospace; background-color: #27272a; color: #a1a1aa; border: 1px solid #3f3f46; border-radius: 6px; cursor: pointer; }
.terminal-toggle:hover, .terminal-toggle.active { background-color: #3f3f46; color: #e4e4e7; }
</style>
