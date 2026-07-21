<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { darkTheme, NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getThemeOverrides } from '@/styles/theme'
import { useTheme } from '@/composables/useTheme'
import { useKeyboard } from '@/composables/useKeyboard'
import { useSessionSearch } from '@/composables/useSessionSearch'
import { useAppStore } from '@/stores/hermes/app'
import AuthEventListener from '@/components/auth/AuthEventListener.vue'
import { desktopBridge } from '@/utils/desktop-bridge'

const AppSidebar = defineAsyncComponent(async () => (await import('@/components/layout/AppSidebar.vue')).default)
const DesktopTitleBar = defineAsyncComponent(async () => (await import('@/components/layout/DesktopTitleBar.vue')).default)
const SessionSearchModal = defineAsyncComponent(async () => (await import('@/components/hermes/chat/SessionSearchModal.vue')).default)
const DefaultCredentialPrompt = defineAsyncComponent(async () => (await import('@/components/auth/DefaultCredentialPrompt.vue')).default)
const ProviderConfigurationPrompt = defineAsyncComponent(async () => (await import('@/components/hermes/models/ProviderConfigurationPrompt.vue')).default)
const WebPet = defineAsyncComponent(async () => (await import('@/components/hermes/pets/WebPet.vue')).default)

const { isDark, isComic } = useTheme()
const { t } = useI18n()
const appStore = useAppStore()
const route = useRoute()
const { sessionSearchOpen } = useSessionSearch()

const themeOverrides = computed(() => getThemeOverrides(isDark.value, isComic.value))
const naiveTheme = computed(() => isDark.value ? darkTheme : null)

const isLoginPage = computed(() => route.name === 'login')
const usesPageSidebar = computed(() =>
  ['hermes.chat', 'hermes.session', 'hermes.history', 'hermes.historySession', 'hermes.globalAgent', 'hermes.globalAgentSession', 'hermes.groupChat', 'hermes.groupChatRoom', 'hermes.workflow'].includes(route.name as string),
)
const showAppSidebar = computed(() => !isLoginPage.value && !usesPageSidebar.value)
const showMobileMenuButton = computed(() => !isLoginPage.value && (showAppSidebar.value || usesPageSidebar.value))

const nodeVersionLow = computed(() => {
  const v = appStore.nodeVersion
  const major = parseInt(v.split('.')[0], 10)
  return !isNaN(major) && major < 23
})

const isDesktopShell = computed(() => desktopBridge()?.isDesktop === true)
const desktopPlatform = computed(() => desktopBridge()?.platform || '')
const isDesktopWindows = computed(() => isDesktopShell.value && desktopPlatform.value === 'win32')
const desktopTitleBarLeft = computed(() => {
  if (isLoginPage.value) return 10
  if (showAppSidebar.value && appStore.sidebarCollapsed) return 84
  return 260
})
const isDesktopPetRoute = computed(() => route.name === 'desktop.pet')
const showWebPet = computed(() => !isLoginPage.value && !isDesktopShell.value && !isDesktopPetRoute.value)
const desktopPlatformClass = computed(() => desktopPlatform.value ? `desktop-platform-${desktopPlatform.value}` : '')
const isDesktopWindowMaximized = ref(false)
let stopWindowStateListener: (() => void) | undefined

function handleMobileMenuClick() {
  if (usesPageSidebar.value) {
    window.dispatchEvent(new CustomEvent('hermes:open-page-sidebar'))
    return
  }
  appStore.toggleSidebar()
}

watch(isLoginPage, (loginPage) => {
  if (loginPage) {
    appStore.stopHealthPolling()
    return
  }
  appStore.loadModels()
  appStore.startHealthPolling()
}, {
  immediate: true,
})

onMounted(() => {
  const bridge = desktopBridge()
  if (!bridge?.isDesktop || desktopPlatform.value !== 'win32') return
  bridge.getWindowState?.()
    .then(state => {
      isDesktopWindowMaximized.value = !!state.isMaximized
    })
    .catch(() => undefined)
  stopWindowStateListener = bridge.onWindowStateChange?.((state) => {
    isDesktopWindowMaximized.value = !!state.isMaximized
  })
})

onUnmounted(() => {
  stopWindowStateListener?.()
  appStore.stopHealthPolling()
})

useKeyboard()
</script>

<template>
  <NConfigProvider :theme="naiveTheme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <AuthEventListener />
      <NDialogProvider>
        <NNotificationProvider>
          <router-view v-if="isDesktopPetRoute" />
          <div v-else class="app-shell" :class="[desktopPlatformClass, { desktop: isDesktopShell, 'desktop-window-maximized': isDesktopWindowMaximized }]">
            <DesktopTitleBar
              v-if="isDesktopWindows"
              :standalone="isLoginPage"
              :left-offset="desktopTitleBarLeft"
            />
            <div v-if="nodeVersionLow" class="node-warning-bar">
              {{ t('sidebar.nodeVersionWarning', { version: appStore.nodeVersion }) }}
            </div>
            <div class="app-layout" :class="{ 'no-sidebar': isLoginPage || !showAppSidebar }">
              <button v-if="showMobileMenuButton" class="hamburger-btn" @click="handleMobileMenuClick">
                <img src="/logo.png" alt="Menu" style="width: 24px; height: 24px;" />
              </button>
              <div v-if="!isLoginPage && showAppSidebar && appStore.sidebarOpen" class="mobile-backdrop" @click="appStore.closeSidebar" />
              <AppSidebar v-if="!isLoginPage && showAppSidebar" />
              <main class="app-main" :class="{ 'app-main--card': showAppSidebar }">
                <router-view />
              </main>
            </div>
          </div>
          <WebPet v-if="showWebPet" />
          <SessionSearchModal v-if="!isDesktopPetRoute && sessionSearchOpen" />
          <DefaultCredentialPrompt v-if="!isDesktopPetRoute" />
          <ProviderConfigurationPrompt v-if="!isDesktopPetRoute" />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-shell {
  position: relative;
  height: calc(100 * var(--vh));
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background-color: $bg-primary;
}

.app-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  background-color: $bg-card;

  &.no-sidebar {
    display: block;
  }
}

.app-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background-color: $bg-primary;

  .no-sidebar & {
    height: 100%;
  }

  &--card {
    margin: 10px 10px 10px 0;
    background-color: $bg-main-surface;
    border: 1px solid $border-color;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  }
}

.app-shell.desktop-platform-darwin,
.app-shell.desktop-platform-win32 {
  &::before {
    content: "";
    position: absolute;
    z-index: 1000;
    top: 0;
    left: 0;
    right: 0;
    height: 10px;
    -webkit-app-region: drag;
  }

  :deep(.page-header),
  :deep(.chat-header),
  :deep(.terminal-header) {
    -webkit-app-region: drag;

    button,
    a,
    input,
    textarea,
    select,
    [role="button"],
    [role="tab"],
    .n-base-selection {
      -webkit-app-region: no-drag;
    }
  }
}

.app-shell.desktop-platform-win32 {
  border-radius: 10px;
  overflow: hidden;

  .app-main--card,
  :deep(.chat-panel > .chat-main),
  :deep(.history-panel > .chat-main),
  :deep(.workflow-view > .workflow-main),
  :deep(.group-chat-panel > .chat-main) {
    margin-top: 50px;
  }

  :deep(.chat-panel > .session-list > .page-sidebar-top),
  :deep(.history-panel > .session-list > .page-sidebar-top),
  :deep(.workflow-view > .workflow-sidebar > .page-sidebar-top),
  :deep(.group-chat-panel > .room-sidebar > .sidebar-header) {
    -webkit-app-region: drag;

    button,
    a,
    input,
    textarea,
    select,
    [role="button"],
    [role="tab"],
    .n-base-selection {
      -webkit-app-region: no-drag;
    }
  }

  &.desktop-window-maximized {
    border-radius: 0;
  }
}

.app-shell.desktop-platform-darwin {
  .app-layout > :deep(.sidebar),
  :deep(.chat-panel > .session-list),
  :deep(.history-panel > .session-list),
  :deep(.workflow-view > .workflow-sidebar),
  :deep(.group-chat-panel > .room-sidebar) {
    position: relative;

    &::before {
      content: "";
      position: absolute;
      z-index: 1;
      top: 0;
      left: 0;
      right: 0;
      height: 32px;
      -webkit-app-region: drag;
    }
  }

  .app-layout > :deep(.sidebar) {
    padding-top: 40px;
  }

  :deep(.chat-panel > .session-list > .page-sidebar-top),
  :deep(.history-panel > .session-list > .page-sidebar-top),
  :deep(.workflow-view > .workflow-sidebar > .page-sidebar-top),
  :deep(.group-chat-panel > .room-sidebar > .sidebar-header) {
    padding-top: 32px;
  }
}

@media (min-width: 769px) {
  .app-main--card {
    overflow: hidden;

    :deep(> *) {
      height: 100% !important;
      max-height: 100%;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .app-main--card {
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
}

.node-warning-bar {
  flex: 0 0 auto;
  width: 100%;
  z-index: 100;
  padding: 4px 16px;
  font-size: 12px;
  font-weight: 500;
  color: #b45309;
  background-color: #fef3c7;
  border-bottom: 1px solid #fde68a;
  text-align: center;
  line-height: 1.4;
}
</style>
