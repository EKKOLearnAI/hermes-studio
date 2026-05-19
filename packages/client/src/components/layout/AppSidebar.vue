<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/hermes/app";
import { getAuthMode, getWebPlane, isUserMode, setRuntimeMode } from "@/api/client";
import { fetchCurrentUser, fetchFeishuUatStatus, pollFeishuUatAuth, startFeishuUatAuth } from "@/api/auth";
import type { FeishuUatAuthSession, FeishuUatStatus } from "@/api/auth";
import { useProfilesStore } from "@/stores/hermes/profiles";
import ProfileSelector from "./ProfileSelector.vue";
import LanguageSwitch from "./LanguageSwitch.vue";
import ThemeSwitch from "./ThemeSwitch.vue";
import { useTheme } from '@/composables/useTheme'
import { useSessionSearch } from '@/composables/useSessionSearch'

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const profilesStore = useProfilesStore();
const { openSessionSearch } = useSessionSearch();
const { isDark, toggleBrightness } = useTheme();
const selectedKey = computed(() => route.name as string);
const logoPath = '/logo.png';
const currentUser = computed(() => profilesStore.currentUser);
const displayName = computed(() => currentUser.value?.name || profilesStore.activeProfileName || '');
const displayProfile = computed(() => currentUser.value?.profile || profilesStore.activeProfileName || '');
const displayInitial = computed(() => (displayName.value || 'H').trim().slice(0, 1).toUpperCase());
const showUserModeChrome = computed(() => isUserMode());
const showAdminSurfaces = computed(() => !showUserModeChrome.value);
const gatewayStandby = computed(() => showUserModeChrome.value && !appStore.connected);
const showFeishuConnector = computed(() => getAuthMode() === 'feishu-oauth-dev');
const feishuUatState = ref<'unknown' | 'checking' | 'connected' | 'missing' | 'connecting' | 'error'>('unknown');
const feishuUatCode = ref('');
const feishuUatError = ref('');
let feishuUatTimer: number | null = null;

const feishuConnectorTitle = computed(() => {
  if (feishuUatState.value === 'connected') return t('sidebar.feishuConnected');
  if (feishuUatState.value === 'connecting') return feishuUatCode.value
    ? `${t('sidebar.feishuConnecting')} ${feishuUatCode.value}`
    : t('sidebar.feishuConnecting');
  if (feishuUatState.value === 'checking') return t('sidebar.feishuChecking');
  if (feishuUatState.value === 'error') return feishuUatError.value || t('sidebar.feishuConnectFailed');
  return t('sidebar.feishuNotConnected');
});

function isFeishuCapabilityConnected(status: FeishuUatStatus) {
  if (status.status === 'valid') return true;
  const larkCli = status.lark_cli;
  return Boolean(larkCli?.available && larkCli.default_identity === 'bot');
}

const collapsedGroups = reactive<Record<string, boolean>>({});

type SidebarGroupKey = "Conversation" | "Agent" | "Monitoring" | "System";

function groupLabel(key: SidebarGroupKey) {
  return t(`sidebar.group${key}${appStore.sidebarCollapsed ? "Short" : ""}`);
}

function toggleGroup(key: string) {
  collapsedGroups[key] = !collapsedGroups[key];
}

function isGroupCollapsed(key: string) {
  return !!collapsedGroups[key];
}

function handleNav(key: string) {
  router.push({ name: key });
}

async function refreshFeishuUatStatus() {
  if (!showFeishuConnector.value) return;
  feishuUatState.value = 'checking';
  feishuUatError.value = '';
  try {
    const status = await fetchFeishuUatStatus();
    feishuUatState.value = isFeishuCapabilityConnected(status) ? 'connected' : 'missing';
  } catch (err: any) {
    feishuUatState.value = 'error';
    feishuUatError.value = err?.message || t('sidebar.feishuConnectFailed');
  }
}

async function handleFeishuConnectorClick() {
  if (feishuUatState.value === 'connected' || feishuUatState.value === 'checking') {
    await refreshFeishuUatStatus();
    return;
  }
  if (feishuUatState.value === 'connecting') return;
  const authWindow = window.open('about:blank', '_blank');
  feishuUatState.value = 'connecting';
  feishuUatError.value = '';
  feishuUatCode.value = '';
  try {
    const session = await startFeishuUatAuth();
    feishuUatCode.value = session.user_code || '';
    if (session.verification_uri) {
      if (authWindow) {
        authWindow.opener = null;
        authWindow.location.href = session.verification_uri;
      } else {
        window.location.assign(session.verification_uri);
      }
    } else if (authWindow) {
      authWindow.close();
    }
    beginFeishuUatPolling(session);
  } catch (err: any) {
    if (authWindow) authWindow.close();
    feishuUatState.value = 'error';
    feishuUatError.value = err?.message || t('sidebar.feishuConnectFailed');
  }
}

function beginFeishuUatPolling(session: FeishuUatAuthSession) {
  if (feishuUatTimer) window.clearTimeout(feishuUatTimer);
  const intervalSeconds = Math.max(Number(session.interval || 3), 1);
  feishuUatTimer = window.setTimeout(async () => {
    try {
      const next = await pollFeishuUatAuth(session.session_id);
      if (next.status === 'success') {
        feishuUatState.value = 'connected';
        feishuUatCode.value = '';
        return;
      }
      if (next.status === 'error' || next.status === 'expired') {
        feishuUatState.value = 'error';
        feishuUatError.value = next.error || t('sidebar.feishuConnectFailed');
        return;
      }
      beginFeishuUatPolling(session);
    } catch (err: any) {
      feishuUatState.value = 'error';
      feishuUatError.value = err?.message || t('sidebar.feishuConnectFailed');
    }
  }, intervalSeconds * 1000);
}

async function handleLogout() {
  const authMode = getAuthMode();
  const webPlane = getWebPlane();
  if (authMode === 'feishu-oauth-dev') {
    try {
      await fetch('/api/auth/feishu/logout', { method: 'POST' });
    } catch {
      // Local cleanup still matters if the network request fails.
    }
  }
  profilesStore.setCurrentUser(null);
  localStorage.clear();
  if (authMode === 'feishu-oauth-dev') {
    setRuntimeMode(authMode, webPlane);
  }
  router.replace({ name: 'login' });
}

onMounted(async () => {
  if (getAuthMode() !== 'feishu-oauth-dev') return;
  try {
    const user = await fetchCurrentUser();
    profilesStore.setBoundProfile(user.profile, user);
    await refreshFeishuUatStatus();
  } catch {
    // Keep the existing profile fallback for non-OAuth or expired sessions.
  }
});

onBeforeUnmount(() => {
  if (feishuUatTimer) window.clearTimeout(feishuUatTimer);
});
</script>

<template>
  <aside class="sidebar" :class="{ open: appStore.sidebarOpen, collapsed: appStore.sidebarCollapsed, 'user-mode': showUserModeChrome }">
    <div class="sidebar-logo" @click="router.push('/hermes/chat')">
      <img :src="logoPath" alt="Hermes" class="logo-img" />
      <span class="logo-text">Hermes</span>
      <!-- <video class="logo-dance" :src="isDark ? danceVideoDark : danceVideoLight" autoplay loop muted playsinline /> -->
    </div>

    <button class="collapse-btn" @click="appStore.toggleSidebarCollapsed()" :title="appStore.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline v-if="appStore.sidebarCollapsed" points="9 18 15 12 9 6" />
        <polyline v-else points="15 18 9 12 15 6" />
      </svg>
    </button>

    <nav class="sidebar-nav">
      <!-- Conversation -->
      <div class="nav-group">
        <div class="nav-group-label" @click="toggleGroup('conversation')">
          <span>{{ groupLabel("Conversation") }}</span>
          <svg class="nav-group-arrow" :class="{ collapsed: isGroupCollapsed('conversation') }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
        <div v-show="!isGroupCollapsed('conversation')" class="nav-group-items">
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.chat' }" @click="handleNav('hermes.chat')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>{{ t("sidebar.chat") }}</span>
          </button>
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.history' }" @click="handleNav('hermes.history')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>{{ t("sidebar.history") }}</span>
          </button>
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.groupChat' }" @click="handleNav('hermes.groupChat')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>{{ t("sidebar.groupChat") }}<span class="beta-tag">(beta)</span></span>
          </button>
          <button class="nav-item" @click="openSessionSearch">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <span>{{ t("sidebar.search") }}</span>
          </button>
        </div>
      </div>

      <!-- Agent -->
      <div class="nav-group">
        <div class="nav-group-label" @click="toggleGroup('agent')">
          <span>{{ groupLabel("Agent") }}</span>
          <svg class="nav-group-arrow" :class="{ collapsed: isGroupCollapsed('agent') }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
        <div v-show="!isGroupCollapsed('agent')" class="nav-group-items">
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.jobs' }" @click="handleNav('hermes.jobs')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>{{ t("sidebar.jobs") }}</span>
          </button>
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.kanban' }" @click="handleNav('hermes.kanban')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="5" height="18" rx="1" />
              <rect x="10" y="3" width="5" height="12" rx="1" />
              <rect x="17" y="3" width="5" height="18" rx="1" />
            </svg>
            <span>{{ t("sidebar.kanban") }}</span>
          </button>
          <button v-if="showAdminSurfaces" class="nav-item" :class="{ active: selectedKey === 'hermes.channels' }" @click="handleNav('hermes.channels')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <span>{{ t("sidebar.channels") }}</span>
          </button>
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.skills' }" @click="handleNav('hermes.skills')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <span>{{ t("sidebar.skills") }}</span>
          </button>
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.memory' }" @click="handleNav('hermes.memory')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18h6" />
              <path d="M10 22h4" />
              <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
            </svg>
            <span>{{ t("sidebar.memory") }}</span>
          </button>
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.files' }" @click="handleNav('hermes.files')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span>{{ t("sidebar.files") }}</span>
          </button>
          <button v-if="showAdminSurfaces" class="nav-item" :class="{ active: selectedKey === 'hermes.models' }" @click="handleNav('hermes.models')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4" />
              <path d="M12 19v4" />
              <path d="M1 12h4" />
              <path d="M19 12h4" />
              <path d="M4.22 4.22l2.83 2.83" />
              <path d="M16.95 16.95l2.83 2.83" />
              <path d="M4.22 19.78l2.83-2.83" />
              <path d="M16.95 7.05l2.83-2.83" />
            </svg>
            <span>{{ t("sidebar.models") }}</span>
          </button>
        </div>
      </div>

      <!-- Monitoring -->
      <div class="nav-group">
        <div class="nav-group-label" @click="toggleGroup('monitoring')">
          <span>{{ groupLabel("Monitoring") }}</span>
          <svg class="nav-group-arrow" :class="{ collapsed: isGroupCollapsed('monitoring') }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
        <div v-show="!isGroupCollapsed('monitoring')" class="nav-group-items">
          <button v-if="showAdminSurfaces" class="nav-item" :class="{ active: selectedKey === 'hermes.logs' }" @click="handleNav('hermes.logs')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <span>{{ t("sidebar.logs") }}</span>
          </button>
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.usage' }" @click="handleNav('hermes.usage')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="12" width="4" height="9" rx="1" />
              <rect x="10" y="7" width="4" height="14" rx="1" />
              <rect x="17" y="3" width="4" height="18" rx="1" />
            </svg>
            <span>{{ t("sidebar.usage") }}</span>
          </button>
        </div>
      </div>

      <!-- System -->
      <div class="nav-group">
        <div class="nav-group-label" @click="toggleGroup('system')">
          <span>{{ groupLabel("System") }}</span>
          <svg class="nav-group-arrow" :class="{ collapsed: isGroupCollapsed('system') }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
        <div v-show="!isGroupCollapsed('system')" class="nav-group-items">
          <button v-if="showAdminSurfaces" class="nav-item" :class="{ active: selectedKey === 'hermes.gateways' }" @click="handleNav('hermes.gateways')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
            <span>{{ t("sidebar.gateways") }}</span>
          </button>
          <button v-if="showAdminSurfaces" class="nav-item" :class="{ active: selectedKey === 'hermes.profiles' }" @click="handleNav('hermes.profiles')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>{{ t("sidebar.profiles") }}</span>
          </button>
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.settings' }" @click="handleNav('hermes.settings')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>{{ t("sidebar.settings") }}</span>
          </button>
        </div>
      </div>
    </nav>

    <div v-if="showFeishuConnector" class="sidebar-integrations">
      <button
        type="button"
        class="feishu-connector"
        :class="feishuUatState"
        :title="feishuConnectorTitle"
        :aria-label="feishuConnectorTitle"
        @click="handleFeishuConnectorClick"
      >
        <span class="feishu-logo-mark" aria-hidden="true">飞</span>
        <span class="feishu-connector-label">{{ feishuConnectorTitle }}</span>
        <span class="feishu-connector-dot" aria-hidden="true"></span>
      </button>
    </div>

    <div v-if="currentUser || showUserModeChrome" class="sidebar-user" :class="{ locked: showUserModeChrome }">
      <div v-if="showUserModeChrome" class="user-card-actions">
        <button class="card-action-button" :title="isDark ? 'Light mode' : 'Dark mode'" :aria-label="isDark ? 'Light mode' : 'Dark mode'" @click="toggleBrightness">
          <svg v-if="isDark" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>
        <button class="card-logout-button" :title="t('sidebar.logout')" :aria-label="t('sidebar.logout')" @click="handleLogout">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
      <div class="user-avatar-wrap">
        <img v-if="currentUser?.avatarUrl" :src="currentUser.avatarUrl" :alt="displayName" class="user-avatar" />
        <div v-else class="user-avatar fallback">{{ displayInitial }}</div>
        <span class="user-status-dot" :class="{ connected: appStore.connected, standby: gatewayStandby }"></span>
      </div>
      <div class="user-meta">
        <div class="user-name-row">
          <span class="user-name">{{ displayName }}</span>
        </div>
        <div class="user-profile">{{ displayProfile }}</div>
      </div>
    </div>
    <ProfileSelector v-else />

    <div v-if="showAdminSurfaces" class="sidebar-footer">
      <button class="nav-item logout-item" @click="handleLogout">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        <span>{{ t("sidebar.logout") }}</span>
      </button>
      <div class="status-row">
        <div
          class="status-indicator"
          :class="{
            connected: appStore.connected,
            disconnected: !appStore.connected,
          }"
        >
          <span class="status-dot"></span>
          <span v-if="showAdminSurfaces" class="status-text">{{
            appStore.connected
              ? t("sidebar.connected")
              : t("sidebar.disconnected")
          }}</span>
        </div>
        <LanguageSwitch v-if="showAdminSurfaces" />
        <ThemeSwitch />
      </div>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.sidebar {
  position: relative;
  width: $sidebar-width;
  height: calc(100 * var(--vh));
  background-color: $bg-sidebar;
  border-right: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  padding: 0 12px 20px;
  flex-shrink: 0;
  transition: width $transition-normal;
}

.sidebar.user-mode {
  background:
    linear-gradient(180deg, rgba(242, 247, 252, 0.96), rgba(247, 249, 251, 0.98)),
    $bg-sidebar;
  border-right-color: rgba(37, 99, 235, 0.14);

  .dark & {
    background:
      linear-gradient(180deg, rgba(24, 28, 35, 0.98), rgba(20, 22, 26, 0.98)),
      $bg-sidebar;
    border-right-color: rgba(96, 165, 250, 0.16);
  }

  .sidebar-logo {
    background: transparent;
    box-shadow: none;
    border-bottom: 1px solid rgba(var(--accent-primary-rgb), 0.08);

    .dark & {
      background: transparent;
    }
  }

  .logo-img {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
  }

  .logo-text {
    font-size: 19px;
    letter-spacing: 0;
  }

  .nav-group-label {
    color: rgba(var(--text-muted-rgb), 0.86);
    letter-spacing: 0.04em;
  }

  .nav-item {
    position: relative;
    min-height: 42px;
    border: 1px solid transparent;
    border-radius: 8px;

    &:hover {
      background: rgba(37, 99, 235, 0.06);
      border-color: rgba(37, 99, 235, 0.1);
    }

    &.active {
      color: #1d4ed8;
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.13), rgba(20, 184, 166, 0.08));
      border-color: rgba(37, 99, 235, 0.16);
      box-shadow: inset 3px 0 0 rgba(37, 99, 235, 0.72);
    }

    .dark &.active {
      color: #bfdbfe;
      background: linear-gradient(135deg, rgba(96, 165, 250, 0.18), rgba(45, 212, 191, 0.08));
      border-color: rgba(96, 165, 250, 0.2);
      box-shadow: inset 3px 0 0 rgba(96, 165, 250, 0.82);
    }
  }

  .sidebar-user.locked {
    border-color: rgba(var(--accent-primary-rgb), 0.08);
    background: transparent;
    box-shadow: none;

    .dark & {
      background: transparent;
      border-color: rgba(var(--accent-primary-rgb), 0.08);
      box-shadow: none;
    }
  }

}

.logo-img {
  width: 28px;
  height: 28px;
  border-radius: 0;
  flex-shrink: 0;
}

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 12px;
  margin: 0 -12px;
  color: $text-primary;
  cursor: pointer;
  background-color: $bg-card;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);

  .dark & {
    background-color: #393939;
  }
  position: relative;
  overflow: hidden;

  .logo-text {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .logo-dance {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    height: 100px;
    border-radius: $radius-md;
    object-fit: contain;
    flex-shrink: 0;
    width: auto;
    pointer-events: none;
  }
}

.sidebar-nav {
  flex: 1;
  display: flex;
  padding-top: 12px;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

:deep(.profile-selector) {
  padding-top: 12px;
  border-top: 1px solid $border-color;
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;

  &.nav-group-bottom {
    margin-top: auto;
    padding-top: 8px;
    border-top: 1px solid $border-color;
  }
}

.nav-group-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-group-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  padding: 8px 12px 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
  border-radius: $radius-sm;
  transition: color $transition-fast;

  &:hover {
    color: $text-secondary;
  }

  .nav-group:first-child & {
    padding-top: 0;
  }
}

.nav-group-arrow {
  transition: transform $transition-fast;
  flex-shrink: 0;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: none;
  background: none;
  color: $text-secondary;
  font-size: 14px;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;
  width: 100%;
  text-align: left;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    background-color: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  .beta-tag {
    font-size: 10px;
    color: $text-muted;
    margin-left: 2px;
  }
}

.sidebar-footer {
  padding-top: 8px;
  border-top: 1px solid $border-color;
}

.sidebar-integrations {
  display: flex;
  padding: 8px 0 0;
  margin: 8px 0 0;
  border-top: 1px solid rgba(var(--accent-primary-rgb), 0.08);
}

.feishu-connector {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  color: $text-secondary;
  background: transparent;
  cursor: pointer;
  transition: color $transition-fast, background $transition-fast, border-color $transition-fast;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.06);
    border-color: rgba(var(--accent-primary-rgb), 0.12);
  }

  &.connected .feishu-connector-dot {
    background: $success;
    box-shadow: 0 0 0 3px rgba(var(--success-rgb), 0.14);
  }

  &.missing .feishu-connector-dot,
  &.error .feishu-connector-dot,
  &.unknown .feishu-connector-dot {
    background: $error;
    box-shadow: 0 0 0 3px rgba(var(--error-rgb, 239, 68, 68), 0.12);
  }

  &.checking .feishu-connector-dot,
  &.connecting .feishu-connector-dot {
    background: #d97706;
    box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.12);
  }
}

.feishu-logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  background: linear-gradient(135deg, #2b7fff 0%, #00b2ff 42%, #25c26e 100%);
  flex-shrink: 0;
}

.feishu-connector-label {
  min-width: 0;
  flex: 1;
  color: inherit;
  font-size: 12px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.feishu-connector-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: $text-muted;
  flex-shrink: 0;
}

.sidebar-user {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 62px 12px 12px;
  margin: 8px -4px 0;
  border-top: 1px solid rgba(var(--accent-primary-rgb), 0.08);
  background: transparent;

  &.locked {
    align-items: center;
    min-height: 58px;
  }
}

.user-card-actions {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
}

.card-action-button,
.card-logout-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: $text-muted;
  background: transparent;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: color $transition-fast, background $transition-fast, border-color $transition-fast;

  &:hover {
    color: $error;
    background: rgba(var(--error-rgb, 239, 68, 68), 0.06);
    border-color: rgba(var(--error-rgb, 239, 68, 68), 0.12);
  }
}

.user-avatar-wrap {
  position: relative;
  flex-shrink: 0;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  background: $bg-card;

  &.fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    color: $text-primary;
    font-size: 14px;
    font-weight: 600;
    background: rgba(var(--accent-primary-rgb), 0.14);
  }
}

.user-status-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid $bg-sidebar;
  background: $text-muted;

  &.connected {
    background: $success;
  }

  &.standby {
    background: #d97706;
    box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.12);
  }
}

.user-meta {
  min-width: 0;
  flex: 1;
  padding-right: 2px;
  line-height: 1.2;
}

.user-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;

  .user-name {
    color: $text-secondary;
    font-size: 14px;
    line-height: 1.25;
    font-weight: 500;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
  }
}

.user-profile {
  margin-top: 2px;
  color: $text-muted;
  font-size: 12px;
  line-height: 1.25;
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}

.logout-item {
  margin: 0 -12px;
  padding: 10px 12px;
  border-radius: 0;
  font-size: 13px;
  color: $text-muted;

  &:hover {
    color: $error;
    background: rgba(var(--error-rgb, 239, 68, 68), 0.06);
  }
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  &.connected .status-dot {
    background-color: $success;
    box-shadow: 0 0 6px rgba(var(--success-rgb), 0.5);
  }

  &.disconnected .status-dot {
    background-color: $error;
  }

  .status-text {
    color: $text-secondary;
  }
}

// ─── Collapsed sidebar (icon-rail mode) ─────────────────────────

.sidebar.collapsed {
  width: $sidebar-collapsed-width;
  padding: 0 8px 12px;
  overflow: hidden;

  .sidebar-logo {
    padding: 12px 4px 8px;
    margin: 0 -8px;
    justify-content: center;
    gap: 0;

    .logo-text {
      display: none;
    }
  }

  .collapse-btn {
    display: flex;
    margin: 0 auto 8px;
  }

  .nav-group-label {
    justify-content: center;
    gap: 2px;
    padding: 8px 0 4px;
    letter-spacing: 0;

    span {
      max-width: 36px;
      overflow: hidden;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .nav-item {
    justify-content: center;
    padding: 10px 4px;
    gap: 0;

    span {
      display: none;
    }

    svg {
      flex-shrink: 0;
    }
  }

  // Hide selectors and footer text, keep theme switch
  :deep(.profile-selector),
  :deep(.model-selector) {
    display: none;
  }

  .sidebar-footer {
    .logout-item {
      margin: 0;
      padding: 10px 4px;
      border-radius: $radius-sm;
    }

    .logout-item span {
      display: none;
    }

    .status-text {
      display: none;
    }

    .status-row {
      justify-content: center;
    }
  }

  .sidebar-user {
    justify-content: center;
    padding: 8px 4px;
    border-color: transparent;
    background: transparent;

    .user-card-actions {
      display: none;
    }

    .user-meta {
      display: none;
    }
  }

  .sidebar-integrations {
    justify-content: center;
    padding-top: 8px;
  }

  .feishu-connector {
    width: 36px;
    height: 36px;
    min-height: 36px;
    padding: 0;
    justify-content: center;
  }

  .feishu-connector-label {
    display: none;
  }

  .feishu-connector-dot {
    position: absolute;
    right: 5px;
    bottom: 5px;
    border: 2px solid $bg-sidebar;
  }
}

// ─── Collapse button ────────────────────────────────────────────

.collapse-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  color: $text-muted;
  border-radius: $radius-sm;
  cursor: pointer;
  flex-shrink: 0;
  margin-left: auto;
  margin-right: 0;
  transition: all $transition-fast;

  &:hover {
    color: $text-primary;
    background-color: rgba(var(--accent-primary-rgb), 0.08);
  }
}

// In expanded mode, overlap the top-right of the logo area
.sidebar:not(.collapsed) .collapse-btn {
  position: absolute;
  top: 18px;
  right: 16px;
  z-index: 5;
}

@media (max-width: $breakpoint-mobile) {
  .logo-dance {
    display: none;
  }

  .status-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 1000;
    transform: translateX(-100%);
    transition: transform $transition-normal;

    &.open {
      transform: translateX(0);
    }

    // Override global utility — sidebar is always 240px wide
    .input-sm {
      width: 90px;
    }
  }
}

.fun-link {
  text-decoration: none;
}
</style>
