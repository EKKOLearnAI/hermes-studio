<script setup lang="ts">
import { onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { darkTheme, NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getThemeOverrides } from '@/styles/theme'
import { useTheme } from '@/composables/useTheme'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import DesktopTitleBar from '@/components/layout/DesktopTitleBar.vue'
import { useKeyboard } from '@/composables/useKeyboard'
import { useAppStore } from '@/stores/hermes/app'
import SessionSearchModal from '@/components/hermes/chat/SessionSearchModal.vue'
import AuthEventListener from '@/components/auth/AuthEventListener.vue'
import DefaultCredentialPrompt from '@/components/auth/DefaultCredentialPrompt.vue'

const { isDark, isComic } = useTheme()
const { t } = useI18n()
const appStore = useAppStore()
const route = useRoute()

const themeOverrides = computed(() => getThemeOverrides(isDark.value, isComic.value))
const naiveTheme = computed(() => isDark.value ? darkTheme : null)

const isLoginPage = computed(() => route.name === 'login')

const nodeVersionLow = computed(() => {
  const v = appStore.nodeVersion
  const major = parseInt(v.split('.')[0], 10)
  return !isNaN(major) && major < 23
})

const isDesktopShell = computed(() =>
  (window as typeof window & { hermesDesktop?: { isDesktop?: boolean } }).hermesDesktop?.isDesktop === true,
)

// Close mobile sidebar on route change
watch(() => route.path, () => {
  appStore.closeSidebar()
})

onMounted(() => {
  if (!isLoginPage.value) {
    appStore.loadModels()
    appStore.startHealthPolling()
  }
})

onUnmounted(() => {
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
          <div class="app-shell" :class="{ desktop: isDesktopShell }">
            <DesktopTitleBar v-if="isDesktopShell" />
            <div v-if="nodeVersionLow" class="node-warning-bar">
              {{ t('sidebar.nodeVersionWarning', { version: appStore.nodeVersion }) }}
            </div>
            <div class="app-layout" :class="{ 'no-sidebar': isLoginPage }">
              <button v-if="!isLoginPage" class="hamburger-btn" @click="appStore.toggleSidebar">
                <img src="/logo.png" alt="Menu" style="width: 24px; height: 24px;" />
              </button>
              <div v-if="!isLoginPage && appStore.sidebarOpen" class="mobile-backdrop" @click="appStore.closeSidebar" />
              <AppSidebar v-if="!isLoginPage" />
              <main class="app-main">
                <router-view />
              </main>
            </div>
          </div>
          <SessionSearchModal />
          <DefaultCredentialPrompt />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-shell {
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

  &.no-sidebar {
    display: block;
  }
}

.app-shell.desktop .app-layout {
  --vh: calc(1vh - 0.36px);
}

.app-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background-color: $bg-primary;

  .no-sidebar & {
    height: 100%;
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
