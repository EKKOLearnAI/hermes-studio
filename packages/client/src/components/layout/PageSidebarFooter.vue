<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NButton, NModal, NPopover, useMessage } from 'naive-ui'
import { useAppStore } from '@/stores/hermes/app'
import { getStoredUsername } from '@/api/client'
import ProfileSelector from '@/components/layout/ProfileSelector.vue'
import ModelSelector from '@/components/layout/ModelSelector.vue'
import LanguageSwitch from '@/components/layout/LanguageSwitch.vue'
import ThemeSwitch from '@/components/layout/ThemeSwitch.vue'
import VersionManagementModal from '@/components/layout/VersionManagementModal.vue'
import { changelog } from '@/data/changelog'

const appStore = useAppStore()
const message = useMessage()
const router = useRouter()
const { t } = useI18n()

const showChangelog = ref(false)
const showVersionManagement = ref(false)
const currentUsername = computed(() => getStoredUsername())
const isDesktopShell = computed(() =>
  (window as typeof window & { hermesDesktop?: { isDesktop?: boolean } }).hermesDesktop?.isDesktop === true,
)

function openSettingsPage() {
  void router.push({ name: 'hermes.settings' })
}

function openChangelog() {
  showChangelog.value = true
}

function openVersionManagement() {
  showVersionManagement.value = true
}

function handleReloadClient() {
  appStore.reloadClient()
}

async function handleUpdate() {
  const ok = await appStore.doUpdate()
  if (ok) {
    message.success(t('sidebar.updateSuccess'), { duration: 5000 })
  } else {
    message.error(t('sidebar.updateFailed'))
  }
}

function handleLogout() {
  localStorage.clear()
  window.location.reload()
}
</script>

<template>
  <div class="page-sidebar-bottom">
    <NPopover
      trigger="click"
      placement="top-start"
      :show-arrow="false"
      raw
    >
      <template #trigger>
        <button class="page-sidebar-menu-btn" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>{{ t('sidebar.settings') }}</span>
        </button>
      </template>
      <div class="page-sidebar-popover">
        <ProfileSelector />
        <ModelSelector />
        <div class="page-sidebar-popover-row">
          <div
            class="status-indicator"
            :class="{ connected: appStore.connected, disconnected: !appStore.connected }"
          >
            <span class="status-dot"></span>
            <span class="status-text">{{ appStore.connected ? t('sidebar.connected') : t('sidebar.disconnected') }}</span>
          </div>
          <LanguageSwitch />
        </div>
        <div class="page-sidebar-version-row">
          <div class="page-sidebar-version-links">
            <a class="page-sidebar-link" href="https://github.com/EKKOLearnAI/hermes-web-ui" target="_blank" rel="noopener noreferrer" title="GitHub">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            </a>
            <a class="page-sidebar-link" href="https://hermes-studio.ai/" target="_blank" rel="noopener noreferrer" title="Website">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            </a>
          </div>
          <span
            class="page-sidebar-version-text"
            role="button"
            tabindex="0"
            @click="openChangelog"
            @keydown.enter="openChangelog"
            @keydown.space.prevent="openChangelog"
          >
            Studio v{{ appStore.serverVersion || '0.1.0' }}
          </span>
          <ThemeSwitch />
        </div>
        <button class="page-sidebar-nav-btn" type="button" @click="openSettingsPage">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
          <span>{{ t('sidebar.settings') }}</span>
        </button>
        <button class="page-sidebar-logout-btn" type="button" @click="handleLogout">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span>{{ t('sidebar.logout') }}</span>
          <span v-if="currentUsername" class="page-sidebar-logout-user" :title="currentUsername">
            {{ currentUsername }}
          </span>
        </button>
        <NButton v-if="isDesktopShell" type="primary" size="tiny" block @click="openVersionManagement">
          {{ t('sidebar.versionManagement') }}
        </NButton>
        <NButton v-if="appStore.clientOutdated" type="warning" size="tiny" block @click="handleReloadClient">
          {{ t('sidebar.reloadClientVersion', { version: appStore.serverVersion }) }}
        </NButton>
        <NButton v-if="appStore.updateAvailable" type="primary" size="tiny" block :loading="appStore.updating" @click="handleUpdate">
          {{ appStore.updating ? t('sidebar.updating') : t('sidebar.updateVersion', { version: appStore.latestVersion }) }}
        </NButton>
      </div>
    </NPopover>
    <NModal v-model:show="showChangelog" preset="dialog" :title="t('sidebar.changelog')" style="width: 520px;">
      <div class="changelog-list">
        <div v-for="entry in changelog" :key="entry.version" class="changelog-version-block">
          <div class="changelog-version-header">
            <span class="changelog-version-tag">v{{ entry.version }}</span>
            <span class="changelog-date">{{ entry.date }}</span>
          </div>
          <ul class="changelog-changes">
            <li v-for="(change, idx) in entry.changes" :key="idx">{{ t(change) }}</li>
          </ul>
        </div>
      </div>
    </NModal>
    <VersionManagementModal v-if="isDesktopShell" v-model:show="showVersionManagement" />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.page-sidebar-bottom {
  flex-shrink: 0;
  padding: 10px 12px;
}

.page-sidebar-menu-btn {
  width: 100%;
  min-width: 0;
  height: 36px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }
}

.page-sidebar-popover {
  width: $sidebar-width;
  padding: 12px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.18);
}

.page-sidebar-popover :deep(.profile-selector),
.page-sidebar-popover :deep(.model-selector) {
  padding: 0;
}

.page-sidebar-popover :deep(.model-selector) {
  margin-bottom: 10px;
}

.page-sidebar-popover :deep(.language-switch) {
  width: 88px;
  flex: 0 0 88px;
}

.page-sidebar-popover :deep(.language-switch .n-base-selection-input__content) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-sidebar-popover-row,
.page-sidebar-version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid $border-color;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: $text-secondary;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-indicator.connected .status-dot {
  background-color: $success;
  box-shadow: 0 0 6px rgba(var(--success-rgb), 0.5);
}

.status-indicator.disconnected .status-dot {
  background-color: $error;
}

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-sidebar-version-row {
  gap: 6px;
}

.page-sidebar-version-links {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
}

.page-sidebar-link {
  color: $text-muted;
  display: flex;
  align-items: center;
  transition: color $transition-fast;

  &:hover {
    color: $text-primary;
  }
}

.page-sidebar-version-text {
  flex: 0 0 auto;
  color: $text-muted;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
  transition: color $transition-fast;

  &:hover {
    color: $accent-primary;
  }
}

.page-sidebar-version-row :deep(.theme-switch-container) {
  flex-shrink: 0;
}

.page-sidebar-nav-btn,
.page-sidebar-logout-btn {
  width: 100%;
  min-width: 0;
  height: 36px;
  border: none;
  border-top: 1px solid $border-color;
  border-radius: 0;
  background: transparent;
  color: $text-secondary;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;
}

.page-sidebar-nav-btn:hover {
  color: $text-primary;
}

.page-sidebar-logout-btn {
  margin-bottom: 6px;

  &:hover {
    color: $error;
  }
}

.page-sidebar-nav-btn span,
.page-sidebar-logout-btn span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 18px;
}

.page-sidebar-logout-user {
  margin-left: auto;
  max-width: 112px;
  color: $text-muted;
  font-size: 12px;
}

.changelog-list {
  max-height: 56vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-right: 4px;
}

.changelog-version-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.changelog-version-tag {
  font-weight: 600;
  color: $text-primary;
}

.changelog-date {
  font-size: 12px;
  color: $text-muted;
}

.changelog-changes {
  margin: 0;
  padding-left: 18px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.5;
}

@media (max-width: $breakpoint-mobile) {
  .page-sidebar-popover {
    width: min(280px, calc(100vw - 32px));
  }

  .page-sidebar-popover :deep(.language-switch) {
    width: 96px;
    flex-basis: 96px;
  }
}
</style>
