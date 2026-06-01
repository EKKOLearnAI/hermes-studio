<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { darkTheme, NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getThemeOverrides } from '@/styles/theme'
import { useTheme } from '@/composables/useTheme'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import { useKeyboard } from '@/composables/useKeyboard'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useMemoryQueueStore } from '@/stores/hermes/memory-queue'
import MemoryReviewQueue from '@/components/hermes/aurora/MemoryReviewQueue.vue'
import AuroraStatusPanel from '@/components/hermes/aurora/AuroraStatusPanel.vue'
import AuroraGovernanceHost from '@/components/hermes/aurora/AuroraGovernanceHost.vue'
import SessionSearchModal from '@/components/hermes/chat/SessionSearchModal.vue'

const { isDark, isComic } = useTheme()
const { t } = useI18n()
const appStore = useAppStore()
const chatStore = useChatStore()
const appWindowStore = useAuroraAppWindowStore()
const memoryQueueStore = useMemoryQueueStore()
const route = useRoute()
const router = useRouter()
const ready = ref(false)

const themeOverrides = computed(() => getThemeOverrides(isDark.value, isComic.value))
const naiveTheme = computed(() => isDark.value ? darkTheme : null)

const isLoginPage = computed(() => route.name === 'login')
const isFullScreenPage = computed(() => route.meta.fullScreen === true)
const isAuroraIdleChrome = computed(() =>
  route.name === 'hermes.chat' &&
  !appStore.isAdvancedConsoleOpen &&
  !chatStore.isRunActive &&
  !chatStore.isLoadingMessages &&
  chatStore.messages.length === 0 &&
  (chatStore.activeSession?.messageCount ?? 0) === 0,
)

const nodeVersionLow = computed(() => {
  const v = appStore.nodeVersion
  const major = parseInt(v.split('.')[0], 10)
  return !isNaN(major) && major < 23
})

// Close mobile sidebar on route change
watch(() => route.path, () => {
  appStore.closeSidebar()
})

// Wait for router to resolve before rendering layout
router.isReady().then(() => {
  ready.value = true
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
    <NMessageProvider placement="bottom-right">
      <NDialogProvider>
        <NNotificationProvider placement="bottom-right">
          <div v-if="nodeVersionLow && ready" class="node-warning-bar">
            {{ t('sidebar.nodeVersionWarning', { version: appStore.nodeVersion }) }}
          </div>
          <div v-if="ready" class="app-layout" :class="{ 'no-sidebar': isLoginPage || isFullScreenPage }">
            <button
              v-if="!appStore.legacyConsoleRetired && !isLoginPage && !isFullScreenPage && !appWindowStore.isOpen && !isAuroraIdleChrome"
              class="advanced-console-toggle"
              :class="{ active: appStore.isAdvancedConsoleOpen }"
              type="button"
              :aria-pressed="appStore.isAdvancedConsoleOpen"
              aria-label="Advanced Console"
              title="Advanced Console"
              @click="appStore.toggleAdvancedConsole"
            >
              <svg
                v-if="!appStore.isAdvancedConsoleOpen"
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="4" y="4" width="6" height="6" rx="1.4" />
                <rect x="14" y="4" width="6" height="6" rx="1.4" />
                <rect x="4" y="14" width="6" height="6" rx="1.4" />
                <rect x="14" y="14" width="6" height="6" rx="1.4" />
              </svg>
              <svg
                v-else
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              v-if="!isLoginPage && !isFullScreenPage && !appWindowStore.isOpen && !isAuroraIdleChrome"
              class="memory-review-toggle"
              :class="{ active: memoryQueueStore.isReviewQueueOpen, attention: memoryQueueStore.pendingCount > 0 }"
              type="button"
              aria-label="Memory Review Queue"
              title="Memory Review Queue"
              @click="memoryQueueStore.toggleReviewQueue"
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5" />
                <path d="M4 13h5l2 3h2l2-3h5" />
                <path d="M7 5h10" />
                <path d="M8 9h8" />
              </svg>
              <span
                v-if="memoryQueueStore.pendingCount > 0"
                class="memory-review-badge"
              >
                {{ memoryQueueStore.pendingCount }}
              </span>
            </button>
            <button
              v-if="!isLoginPage && !isFullScreenPage && !appWindowStore.isOpen && !isAuroraIdleChrome"
              class="aurora-status-toggle"
              :class="{ active: appStore.isAuroraStatusOpen }"
              type="button"
              aria-label="Aurora System Status"
              title="Aurora System Status"
              @click="appStore.toggleAuroraStatus"
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 12h4l2-7 4 14 2-7h4" />
              </svg>
            </button>
            <div
              v-if="!appStore.legacyConsoleRetired && !isLoginPage && !isFullScreenPage && appStore.isAdvancedConsoleOpen && appStore.sidebarOpen"
              class="mobile-backdrop"
              @click="appStore.setAdvancedConsoleOpen(false)"
            />
            <Transition name="advanced-console">
              <AppSidebar
                v-if="!appStore.legacyConsoleRetired && !isLoginPage && !isFullScreenPage && appStore.isAdvancedConsoleOpen"
              />
            </Transition>
            <main class="app-main">
              <router-view />
            </main>
          </div>
          <AuroraStatusPanel v-if="ready && !isLoginPage && !isFullScreenPage" />
          <MemoryReviewQueue v-if="ready && !isLoginPage && !isFullScreenPage" />
          <AuroraGovernanceHost v-if="ready && !isLoginPage && !isFullScreenPage" />
          <SessionSearchModal />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-layout {
  position: relative;
  display: flex;
  height: calc(100 * var(--vh));
  width: 100vw;
  overflow: hidden;

  &.no-sidebar {
    display: block;
  }
}

.app-main {
  flex: 1;
  overflow-y: auto;
  background-color: $bg-primary;

  .no-sidebar & {
    height: calc(100 * var(--vh));
  }
}

.advanced-console-toggle,
.memory-review-toggle,
.aurora-status-toggle {
  position: fixed;
  top: 18px;
  z-index: 1600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.16);
  border-radius: 8px;
  color: rgba(21, 32, 51, 0.62);
  background: rgba(255, 255, 255, 0.52);
  box-shadow:
    0 10px 28px rgba(42, 58, 88, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(16px);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.2, 0, 0, 1);

  &:hover,
  &.active {
    color: $accent-primary;
    border-color: rgba(var(--accent-primary-rgb), 0.34);
    background: rgba(255, 255, 255, 0.72);
    box-shadow:
      0 14px 34px rgba(var(--accent-primary-rgb), 0.14),
      inset 0 1px 0 rgba(255, 255, 255, 0.7);
  }

  &:hover {
    transform: translateY(-1px);
  }
}

.advanced-console-toggle {
  left: 18px;
}

.memory-review-toggle {
  left: 60px;
}

.aurora-status-toggle {
  left: 102px;
}

.memory-review-toggle.attention {
  color: #16724b;
  border-color: rgba(52, 211, 153, 0.28);
  background: rgba(255, 255, 255, 0.7);
}

.memory-review-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 999px;
  color: #fff;
  background: #16a34a;
  box-shadow: 0 8px 20px rgba(22, 163, 74, 0.26);
  font-size: 10px;
  font-weight: 850;
  line-height: 1;
}

.advanced-console-enter-active,
.advanced-console-leave-active {
  transition: all 0.3s cubic-bezier(0.2, 0, 0, 1);
}

.advanced-console-enter-from,
.advanced-console-leave-to {
  opacity: 0;
  transform: translateX(-100%);
}

:global(.dark) .advanced-console-toggle,
:global(.dark) .memory-review-toggle,
:global(.dark) .aurora-status-toggle {
  color: rgba(237, 243, 255, 0.66);
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(18, 22, 32, 0.62);
  box-shadow:
    0 10px 28px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

:global(.dark) .advanced-console-toggle:hover,
:global(.dark) .advanced-console-toggle.active,
:global(.dark) .memory-review-toggle:hover,
:global(.dark) .memory-review-toggle.active,
:global(.dark) .aurora-status-toggle:hover,
:global(.dark) .aurora-status-toggle.active {
  color: #9de9ff;
  border-color: rgba(43, 209, 255, 0.34);
  background: rgba(28, 34, 46, 0.78);
}

:global(.dark) .memory-review-toggle.attention {
  color: #a7f3d0;
  border-color: rgba(52, 211, 153, 0.34);
}

.node-warning-bar {
  position: absolute;
  top: 0;
  left: 0;
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
