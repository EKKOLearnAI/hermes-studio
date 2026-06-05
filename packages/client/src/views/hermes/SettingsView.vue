<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NTabs,
  NTabPane,
  NSpin,
} from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/hermes/settings";
import DisplaySettings from "@/components/hermes/settings/DisplaySettings.vue";
import AgentSettings from "@/components/hermes/settings/AgentSettings.vue";
import GatewayAutoStartSettings from "@/components/hermes/settings/GatewayAutoStartSettings.vue";
import MemorySettings from "@/components/hermes/settings/MemorySettings.vue";
import CompressionSettings from "@/components/hermes/settings/CompressionSettings.vue";
import SessionSettings from "@/components/hermes/settings/SessionSettings.vue";
import PrivacySettings from "@/components/hermes/settings/PrivacySettings.vue";
import ModelSettings from "@/components/hermes/settings/ModelSettings.vue";
import AccountSettings from "@/components/hermes/settings/AccountSettings.vue";
import UserManagementSettings from "@/components/hermes/settings/UserManagementSettings.vue";
import VoiceSettings from "@/components/hermes/settings/VoiceSettings.vue";
import { isStoredSuperAdmin } from "@/api/client";
import { useProfilesStore } from "@/stores/hermes/profiles";

const settingsStore = useSettingsStore();
const profilesStore = useProfilesStore();
const { t } = useI18n();
const canManageUsers = isStoredSuperAdmin();
const route = useRoute();
const router = useRouter();
const activeTab = ref("account");

const validTabs = computed(() => new Set([
  "account",
  ...(canManageUsers ? ["users"] : []),
  "display",
  "agent",
  "memory",
  "compression",
  "session",
  "privacy",
  "models",
  "voice",
]));

function normalizeTab(value: unknown): string {
  const tab = typeof value === "string" ? value : "";
  return validTabs.value.has(tab) ? tab : "account";
}

function handleTabUpdate(tab: string) {
  activeTab.value = normalizeTab(tab);
  router.replace({
    query: {
      ...route.query,
      tab: activeTab.value === "account" ? undefined : activeTab.value,
    },
  });
}

watch(() => route.query.tab, (tab) => {
  activeTab.value = normalizeTab(tab);
}, { immediate: true });

async function loadSettingsForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles();
  }
  await settingsStore.fetchSettings();
}

onMounted(() => {
  void loadSettingsForProfile();
});
</script>

<template>
  <div class="settings-view">
    <header class="page-header">
      <h2 class="header-title">{{ t("settings.title") }}</h2>
    </header>

    <div class="settings-content">
      <NSpin
        :show="settingsStore.loading || settingsStore.saving"
        size="large"
        :description="t('common.loading')"
      >
        <NTabs v-model:value="activeTab" type="line" animated @update:value="handleTabUpdate">
          <NTabPane name="account" :tab="t('settings.tabs.account')">
            <AccountSettings />
          </NTabPane>
          <NTabPane v-if="canManageUsers" name="users" :tab="t('settings.tabs.users')">
            <UserManagementSettings />
          </NTabPane>
          <NTabPane name="display" :tab="t('settings.tabs.display')">
            <DisplaySettings />
          </NTabPane>
          <NTabPane name="agent" :tab="t('settings.tabs.agent')">
            <AgentSettings />
            <GatewayAutoStartSettings />
          </NTabPane>
          <NTabPane name="memory" :tab="t('settings.tabs.memory')">
            <MemorySettings />
          </NTabPane>
          <NTabPane name="compression" :tab="t('settings.tabs.compression')">
            <CompressionSettings />
          </NTabPane>
          <NTabPane name="session" :tab="t('settings.tabs.session')">
            <SessionSettings />
          </NTabPane>
          <NTabPane name="privacy" :tab="t('settings.tabs.privacy')">
            <PrivacySettings />
          </NTabPane>
          <NTabPane name="models" :tab="t('settings.tabs.models')">
            <ModelSettings />
          </NTabPane>
          <NTabPane name="voice" :tab="t('settings.tabs.voice')">
            <VoiceSettings />
          </NTabPane>
        </NTabs>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.settings-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
