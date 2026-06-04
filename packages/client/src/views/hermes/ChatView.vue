<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AuroraOperatingLayer from '@/components/hermes/aurora/AuroraOperatingLayer.vue'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { isAuroraAppKind } from '@/services/hermes/aurora/route-app-bridge'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

const route = useRoute()
const appStore = useAppStore()
const chatStore = useChatStore()
const appWindowStore = useAuroraAppWindowStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const lastRouteAppLaunchKey = ref('')
const originalTitle = typeof document === 'undefined' ? 'Hermes Studio' : document.title

function queryText(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
  return typeof value === 'string' ? value : undefined
}

function openAuroraAppFromRoute() {
  const appKind = queryText(route.query.app)
  if (!isAuroraAppKind(appKind)) return

  const launchKey = `${appKind}:${route.fullPath}`
  if (launchKey === lastRouteAppLaunchKey.value) return
  lastRouteAppLaunchKey.value = launchKey

  appWindowStore.openApp(appKind, {
    source: 'legacy-route-bridge',
    legacyPath: queryText(route.query.legacyPath),
  })
}

function isAuroraDesktopRoute() {
  const appKind = queryText(route.query.app)
  const hashPath = typeof window === 'undefined' ? '' : window.location.hash
  const fullPath = typeof route.fullPath === 'string' ? route.fullPath : ''
  const isAuroraPath =
    route.path === '/aurora' ||
    fullPath.startsWith('/aurora') ||
    hashPath.startsWith('#/aurora')
  return isAuroraPath && !isAuroraAppKind(appKind)
}

function updateDocumentTitle() {
  if (typeof document === 'undefined') return
  const sessionTitle = chatStore.activeSession?.title?.trim()
  document.title = sessionTitle || 'Hermes Studio'
}

async function requestAuroraDesktopFromRoute() {
  if (!isAuroraDesktopRoute()) return
  await nextTick()
  appWindowStore.closeApp()
  appStore.requestAuroraDesktop()
}

onMounted(async () => {
  appStore.loadModels()
  // 先加载 profile，确保缓存 key 使用正确的 profile name；同时预取显示设置，
  // 让聊天完成提示音不依赖用户先打开 Settings 页面。
  await Promise.all([
    profilesStore.fetchProfiles(),
    settingsStore.fetchSettings(),
  ])
  await chatStore.loadSessions()
  openAuroraAppFromRoute()
  void requestAuroraDesktopFromRoute()
})

watch(
  () => [route.path, route.query.app, route.fullPath],
  () => {
    openAuroraAppFromRoute()
    void requestAuroraDesktopFromRoute()
  },
)

watch(() => chatStore.activeSession?.title, updateDocumentTitle, { immediate: true })

onUnmounted(() => {
  if (typeof document !== 'undefined') document.title = originalTitle || 'Hermes Studio'
})
</script>

<template>
  <div class="chat-view">
    <AuroraOperatingLayer>
      <ChatPanel />
    </AuroraOperatingLayer>
  </div>
</template>

<style scoped lang="scss">
.chat-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}
</style>
