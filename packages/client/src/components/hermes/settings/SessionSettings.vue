<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NButton, NInputNumber, NSelect, NSwitch, NTag, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/hermes/settings";
import { useSessionBrowserPrefsStore } from "@/stores/hermes/session-browser-prefs";
import {
  approvePendingWrite,
  fetchPendingWriteDiff,
  fetchPendingWrites,
  rejectPendingWrite,
  type PendingWriteRecord,
} from "@/api/hermes/write-gate";
import SettingRow from "./SettingRow.vue";

const settingsStore = useSettingsStore();
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore();
const message = useMessage();
const { t } = useI18n();
const pendingWrites = ref<PendingWriteRecord[]>([]);
const pendingLoading = ref(false);
const pendingAction = ref("");
const expandedDiffs = ref<Record<string, string>>({});
const pendingCount = computed(() => pendingWrites.value.length);

// 防抖保存：每个字段独立定时器，300ms 内只发最后一次 HTTP 请求
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function save(values: Record<string, any>) {
  // NSelect/NSwitch 等一次性操作，直接保存，不需要防抖
  settingsStore.updateLocal('session_reset', values)
  settingsStore.saveSection('session_reset', values).then(() => {
    message.success(t("settings.saved"));
  }).catch(() => {
    message.error(t("settings.saveFailed"));
  });
}

function debouncedSave(key: string, value: any) {
  // 先立即更新本地 store（UI 即时响应）
  settingsStore.updateLocal('session_reset', { [key]: value });
  // 再防抖发 HTTP 保存
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(async () => {
    try {
      await settingsStore.saveSection('session_reset', { [key]: value });
      message.success(t("settings.saved"));
    } catch (err: any) {
      message.error(t("settings.saveFailed"));
    }
  }, 300);
}

async function toggleRequireAuth(value: boolean) {
  try {
    await settingsStore.saveSection("approvals", { mode: value ? "manual" : "off" });
    message.success(t("settings.saved"));
  } catch (err: any) {
    message.error(t("settings.saveFailed"));
  }
}

async function toggleWriteApproval(section: "memory" | "skills", value: boolean) {
  try {
    settingsStore.updateLocal(section, { write_approval: value });
    await settingsStore.saveSection(section, { write_approval: value });
    message.success(t("settings.saved"));
  } catch (err: any) {
    message.error(t("settings.saveFailed"));
  }
}

function pendingKey(record: PendingWriteRecord): string {
  return `${record.subsystem}:${record.id}`;
}

function formatPendingTime(value: number | null): string {
  if (!value) return "";
  return new Date(value * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadPendingWrites() {
  pendingLoading.value = true;
  try {
    const data = await fetchPendingWrites();
    pendingWrites.value = data.records || [];
  } catch (err: any) {
    message.error(t("settings.session.writeApprovalLoadFailed"));
  } finally {
    pendingLoading.value = false;
  }
}

async function toggleDiff(record: PendingWriteRecord) {
  const key = pendingKey(record);
  if (expandedDiffs.value[key]) {
    const next = { ...expandedDiffs.value };
    delete next[key];
    expandedDiffs.value = next;
    return;
  }
  pendingAction.value = `${key}:diff`;
  try {
    const diff = await fetchPendingWriteDiff(record.subsystem, record.id);
    expandedDiffs.value = { ...expandedDiffs.value, [key]: diff || t("settings.session.writeApprovalNoDiff") };
  } catch (err: any) {
    message.error(t("settings.session.writeApprovalDiffFailed"));
  } finally {
    pendingAction.value = "";
  }
}

async function resolvePendingWrite(record: PendingWriteRecord, decision: "approve" | "reject") {
  const key = pendingKey(record);
  pendingAction.value = `${key}:${decision}`;
  try {
    if (decision === "approve") {
      await approvePendingWrite(record.subsystem, record.id);
      message.success(t("settings.session.writeApprovalApproved"));
    } else {
      await rejectPendingWrite(record.subsystem, record.id);
      message.success(t("settings.session.writeApprovalRejected"));
    }
    const nextDiffs = { ...expandedDiffs.value };
    delete nextDiffs[key];
    expandedDiffs.value = nextDiffs;
    await loadPendingWrites();
  } catch (err: any) {
    message.error(t("settings.session.writeApprovalActionFailed"));
  } finally {
    pendingAction.value = "";
  }
}

onMounted(() => {
  void loadPendingWrites();
});
</script>

<template>
  <section class="settings-section">
    <SettingRow
      :label="t('settings.session.requireAuth')"
      :hint="t('settings.session.requireAuthHint')"
    >
      <NSwitch :value="settingsStore.approvals.mode === 'manual'" @update:value="toggleRequireAuth" />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.memoryWriteApproval')"
      :hint="t('settings.session.memoryWriteApprovalHint')"
    >
      <NSwitch
        :value="settingsStore.memory.write_approval === true"
        @update:value="(value) => toggleWriteApproval('memory', value)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.skillsWriteApproval')"
      :hint="t('settings.session.skillsWriteApprovalHint')"
    >
      <NSwitch
        :value="settingsStore.skills.write_approval === true"
        @update:value="(value) => toggleWriteApproval('skills', value)"
      />
    </SettingRow>
    <div class="write-approval-panel">
      <div class="write-approval-header">
        <div>
          <h3>{{ t("settings.session.writeApprovalTitle") }}</h3>
          <p>{{ t("settings.session.writeApprovalDescription") }}</p>
        </div>
        <NButton size="small" quaternary :loading="pendingLoading" @click="loadPendingWrites">
          {{ t("settings.session.writeApprovalRefresh") }}
        </NButton>
      </div>
      <div v-if="pendingLoading && pendingCount === 0" class="write-approval-state">
        {{ t("common.loading") }}
      </div>
      <div v-else-if="pendingCount === 0" class="write-approval-state">
        {{ t("settings.session.writeApprovalEmpty") }}
      </div>
      <div v-else class="write-approval-list">
        <div v-for="record in pendingWrites" :key="pendingKey(record)" class="write-approval-item">
          <div class="write-approval-main">
            <div class="write-approval-meta">
              <NTag size="small" :type="record.subsystem === 'memory' ? 'info' : 'warning'">
                {{ record.subsystem === 'memory' ? t("settings.session.writeApprovalMemory") : t("settings.session.writeApprovalSkills") }}
              </NTag>
              <span>{{ record.action || "-" }}</span>
              <span>{{ record.origin }}</span>
              <span v-if="record.created_at">{{ formatPendingTime(record.created_at) }}</span>
            </div>
            <div class="write-approval-summary">{{ record.summary || record.id }}</div>
          </div>
          <div class="write-approval-actions">
            <NButton
              size="tiny"
              quaternary
              :loading="pendingAction === `${pendingKey(record)}:diff`"
              @click="toggleDiff(record)"
            >
              {{ expandedDiffs[pendingKey(record)] ? t("settings.session.writeApprovalHideDiff") : t("settings.session.writeApprovalViewDiff") }}
            </NButton>
            <NButton
              size="tiny"
              type="success"
              :loading="pendingAction === `${pendingKey(record)}:approve`"
              @click="resolvePendingWrite(record, 'approve')"
            >
              {{ t("settings.session.writeApprovalApprove") }}
            </NButton>
            <NButton
              size="tiny"
              quaternary
              type="error"
              :loading="pendingAction === `${pendingKey(record)}:reject`"
              @click="resolvePendingWrite(record, 'reject')"
            >
              {{ t("settings.session.writeApprovalReject") }}
            </NButton>
          </div>
          <pre v-if="expandedDiffs[pendingKey(record)]" class="write-approval-diff">{{ expandedDiffs[pendingKey(record)] }}</pre>
        </div>
      </div>
    </div>
    <SettingRow
      :label="t('settings.session.mode')"
      :hint="t('settings.session.modeHint')"
    >
      <NSelect
        :value="settingsStore.sessionReset.mode || 'both'"
        :options="[
          { label: t('settings.session.modeBoth'), value: 'both' },
          { label: t('settings.session.modeIdle'), value: 'idle' },
          { label: t('settings.session.modeDaily'), value: 'daily' },
          { label: t('settings.session.modeNone'), value: 'none' },
        ]"
        size="small"
        class="input-md"
        @update:value="(v) => save({ mode: v })"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.idleMinutes')"
      :hint="t('settings.session.idleMinutesHint')"
    >
      <NInputNumber
        :value="settingsStore.sessionReset.idle_minutes"
        :min="10"
        :max="10080"
        :step="30"
        size="small"
        class="input-sm"
        @update:value="(v) => v != null && debouncedSave('idle_minutes', v)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.atHour')"
      :hint="t('settings.session.atHourHint')"
    >
      <NInputNumber
        :value="settingsStore.sessionReset.at_hour"
        :min="0"
        :max="23"
        :step="1"
        size="small"
        class="input-sm"
        @update:value="(v) => v != null && debouncedSave('at_hour', v)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.liveMonitorHumanOnly')"
      :hint="t('settings.session.liveMonitorHumanOnlyHint')"
    >
      <NSwitch
        :value="sessionBrowserPrefsStore.humanOnly"
        @update:value="(value) => sessionBrowserPrefsStore.setHumanOnly(value)"
      />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.settings-section {
  margin-top: 16px;
}

.write-approval-panel {
  margin: 14px 0;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  overflow: hidden;
}

.write-approval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  background: $bg-secondary;
  border-bottom: 1px solid $border-color;

  h3 {
    margin: 0;
    font-size: 14px;
    color: $text-primary;
  }

  p {
    margin: 3px 0 0;
    font-size: 12px;
    color: $text-muted;
  }
}

.write-approval-state {
  padding: 16px 14px;
  color: $text-muted;
  font-size: 13px;
}

.write-approval-list {
  display: flex;
  flex-direction: column;
}

.write-approval-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  padding: 12px 14px;
  border-top: 1px solid $border-color;

  &:first-child {
    border-top: 0;
  }
}

.write-approval-main {
  min-width: 0;
}

.write-approval-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: $text-muted;
}

.write-approval-summary {
  margin-top: 6px;
  font-size: 13px;
  color: $text-primary;
  overflow-wrap: anywhere;
}

.write-approval-actions {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.write-approval-diff {
  grid-column: 1 / -1;
  max-height: 280px;
  overflow: auto;
  margin: 0;
  padding: 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  font-family: $font-code;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}

@media (max-width: $breakpoint-mobile) {
  .write-approval-item {
    grid-template-columns: 1fr;
  }

  .write-approval-actions {
    flex-wrap: wrap;
  }
}
</style>
