<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { setSessionModel } from '@/api/hermes/sessions'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

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

const isNewSessionRoute = computed(() => route.path === '/session/new')
const isContinueRoute = computed(() => isNewSessionRoute.value && route.query.continue === '1')
const isCreatingNewSession = ref(false)

const routeProfile = computed(() => {
  const value = route.query.profile
  return typeof value === 'string' && value.trim() ? value : null
})

async function loadRouteSession() {
  await chatStore.loadSessions(chatStore.sessionProfileFilter, routeSessionId.value)
  if (routeSessionId.value && chatStore.activeSessionId !== routeSessionId.value) {
    await router.replace({ name: 'hermes.chat' })
  }
}

async function openNewSessionRoute() {
  if (isCreatingNewSession.value) return
  isCreatingNewSession.value = true
  try {
    const session = chatStore.newChat()
    await setSessionModel(
      session.id,
      session.model || appStore.selectedModel || '',
      session.provider || appStore.selectedProvider || '',
    )
    await router.replace({
      name: 'hermes.session',
      params: { sessionId: session.id },
    })
    await chatStore.loadSessions(chatStore.sessionProfileFilter, session.id)
  } finally {
    isCreatingNewSession.value = false
  }
}

async function continueRootSessionRoute() {
  if (isCreatingNewSession.value) return
  await chatStore.loadSessions(chatStore.sessionProfileFilter)
  if (chatStore.activeSessionId) {
    await router.replace({
      name: 'hermes.session',
      params: { sessionId: chatStore.activeSessionId },
    })
    return
  }
  await openNewSessionRoute()
}

onMounted(async () => {
  // 先加载模型、profile 和显示设置，确保新会话创建时的默认值与当前新聊天流程一致。
  await Promise.all([
    appStore.loadModels(),
    profilesStore.fetchProfiles(),
    settingsStore.fetchSettings(),
  ])
  if (isContinueRoute.value) {
    await continueRootSessionRoute()
    return
  }
  if (isNewSessionRoute.value) {
    await openNewSessionRoute()
    return
  }
  await loadRouteSession()
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (isContinueRoute.value) {
    if (isCreatingNewSession.value) return
    await continueRootSessionRoute()
    return
  }
  if (isNewSessionRoute.value) {
    if (isCreatingNewSession.value) return
    await openNewSessionRoute()
    return
  }
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
