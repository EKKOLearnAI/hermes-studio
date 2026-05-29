<script setup lang="ts">
import { NButton, NSwitch, NSelect, NSlider, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useTheme, type BrightnessMode } from '@/composables/useTheme'
import { requestCompletionNotificationPermission, showCompletionNotification, type CompletionNotificationPermissionResult } from '@/utils/completion-notification'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()
const { brightness, setBrightness } = useTheme()

const themeOptions = [
  { label: t('settings.display.themeLight'), value: 'light' },
  { label: t('settings.display.themeDark'), value: 'dark' },
  { label: t('settings.display.themeSystem'), value: 'system' },
]

const AVATAR_SIZE_MIN = 24
const AVATAR_SIZE_MAX = 80
const AVATAR_SIZE_DEFAULT = 40

const avatarSize = settingsStore.display.avatar_size ?? AVATAR_SIZE_DEFAULT

function handleAvatarSizeChange(val: number) {
  save({ avatar_size: val })
}

async function save(values: Record<string, any>) {
  try {
    await settingsStore.saveSection('display', values)
    message.success(t('settings.saved'))
  } catch (err: any) {
    message.error(t('settings.saveFailed'))
  }
}

function handleThemeChange(val: string) {
  const m = val as BrightnessMode
  setBrightness(m)
  save({ skin: m })
}

function notificationPermissionErrorKey(result: CompletionNotificationPermissionResult): string {
  if (result.reason === 'insecure') return 'settings.display.notifyOnCompleteInsecure'
  if (result.reason === 'unsupported') return 'settings.display.notifyOnCompleteUnsupported'
  return 'settings.display.notifyOnCompleteDenied'
}

async function handleNotifyOnCompleteChange(value: boolean) {
  if (value) {
    const result = await requestCompletionNotificationPermission()
    if (!result.granted) {
      message.error(t(notificationPermissionErrorKey(result)))
      return
    }
  }
  await save({ notify_on_complete: value })
  if (value) {
    void showCompletionNotification({
      title: 'Hermes',
      body: t('settings.display.notifyOnCompleteTest'),
      icon: '/coding-agents/hermes.png',
      tag: `hermes-complete-test-${Date.now()}`,
    })
  }
}

async function testCompletionNotification() {
  const result = await requestCompletionNotificationPermission()
  if (!result.granted) {
    message.error(t(notificationPermissionErrorKey(result)))
    return
  }
  const shown = await showCompletionNotification({
    title: 'Hermes',
    body: t('settings.display.notifyOnCompleteTest'),
    icon: '/coding-agents/hermes.png',
    tag: `hermes-complete-test-${Date.now()}`,
  })
  if (!shown) {
    message.error(t('settings.display.notifyOnCompleteTestFailed'))
    return
  }
  message.success(t('settings.display.notifyOnCompleteTestSent'))
}
</script>

<template>
  <section class="settings-section">
    <SettingRow :label="t('settings.display.theme')" :hint="t('settings.display.themeHint')">
      <NSelect :value="brightness" :options="themeOptions" size="small" :consistent-menu-width="false" class="input-sm" @update:value="handleThemeChange" />
    </SettingRow>
    <SettingRow :label="t('settings.display.streaming')" :hint="t('settings.display.streamingHint')">
      <NSwitch :value="settingsStore.display.streaming" @update:value="v => save({ streaming: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.compact')" :hint="t('settings.display.compactHint')">
      <NSwitch :value="settingsStore.display.compact" @update:value="v => save({ compact: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.showReasoning')" :hint="t('settings.display.showReasoningHint')">
      <NSwitch :value="settingsStore.display.show_reasoning" @update:value="v => save({ show_reasoning: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.showCost')" :hint="t('settings.display.showCostHint')">
      <NSwitch :value="settingsStore.display.show_cost" @update:value="v => save({ show_cost: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.inlineDiffs')" :hint="t('settings.display.inlineDiffsHint')">
      <NSwitch :value="settingsStore.display.inline_diffs" @update:value="v => save({ inline_diffs: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.bellOnComplete')" :hint="t('settings.display.bellOnCompleteHint')">
      <NSwitch :value="settingsStore.display.bell_on_complete" @update:value="v => save({ bell_on_complete: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.notifyOnComplete')" :hint="`${t('settings.display.notifyOnCompleteHint')} ${t('settings.display.notifyOnCompleteMacHint')}`">
      <div class="notify-controls">
        <NSwitch :value="settingsStore.display.notify_on_complete" @update:value="handleNotifyOnCompleteChange" />
        <NButton size="tiny" secondary @click="testCompletionNotification">
          {{ t('settings.display.notifyOnCompleteTestButton') }}
        </NButton>
      </div>
    </SettingRow>
    <SettingRow :label="t('settings.display.avatarSize')" :hint="t('settings.display.avatarSizeHint')">
      <div class="avatar-size-control">
        <NSlider :value="avatarSize" :min="AVATAR_SIZE_MIN" :max="AVATAR_SIZE_MAX" :step="2" class="avatar-size-slider" @update:value="handleAvatarSizeChange" />
        <span class="avatar-size-value">{avatarSize}px</span>
      </div>
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.notify-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.avatar-size-control {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 200px;
}

.avatar-size-slider {
  flex: 1;
}

.avatar-size-value {
  font-size: 13px;
  color: var(--n-text-color);
  white-space: nowrap;
  min-width: 40px;
  text-align: right;
}
}
</style>
