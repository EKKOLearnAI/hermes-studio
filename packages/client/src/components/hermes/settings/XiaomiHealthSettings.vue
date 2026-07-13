<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NInput, NSelect, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchScaleSyncSettings,
  runScaleSync,
  updateScaleSyncSettings,
  type ScaleSyncResult,
  type ScaleSyncSettings,
} from '@/api/hermes/health-state'
import { useProfilesStore } from '@/stores/hermes/profiles'
import SettingRow from './SettingRow.vue'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const loading = ref(false)
const saving = ref(false)
const running = ref(false)
const settings = ref<ScaleSyncSettings | null>(null)
const lastResult = ref<ScaleSyncResult | null>(null)
const draft = ref({
  enabled: true,
  source: 'xiaomihome',
  username: '',
  password: '',
  region: 'cn',
  scaleModel: 'yunmai.scales.ms103',
  scaleconnectPath: '',
})

const sourceOptions = [
  { label: 'Xiaomi Home / 米家', value: 'xiaomihome' },
  { label: 'Mi Fitness / 小米运动健康', value: 'mifitness' },
]

onMounted(loadSettings)

async function loadSettings() {
  loading.value = true
  try {
    const loaded = await fetchScaleSyncSettings(activeProfile())
    applySettings(loaded)
  } catch (err: any) {
    message.error(`${t('health.scaleSync.loadFailed')}: ${err.message}`)
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  saving.value = true
  try {
    const loaded = await updateScaleSyncSettings({ ...draft.value }, activeProfile())
    applySettings(loaded)
    message.success(t('settings.saved'))
  } catch (err: any) {
    message.error(`${t('health.scaleSync.saveFailed')}: ${err.message}`)
  } finally {
    saving.value = false
  }
}

async function runNow() {
  running.value = true
  try {
    lastResult.value = await runScaleSync(activeProfile())
  } catch (err: any) {
    message.error(`${t('health.scaleSync.runFailed')}: ${err.message}`)
  } finally {
    running.value = false
  }
}

function applySettings(loaded: ScaleSyncSettings) {
  settings.value = loaded
  draft.value = {
    enabled: loaded.enabled,
    source: loaded.source,
    username: loaded.username,
    password: '',
    region: loaded.region,
    scaleModel: loaded.scaleModel,
    scaleconnectPath: loaded.scaleconnectPath,
  }
}

function activeProfile(): string {
  return profilesStore.activeProfileName || 'default'
}

function statusText(): string {
  if (lastResult.value?.reason) return t(`health.scaleSync.reason.${lastResult.value.reason}`)
  if (lastResult.value?.status === 'synced') return `${t('health.scaleSync.synced')} ${lastResult.value.importedCount}`
  if (settings.value?.configured) return t('health.scaleSync.ready')
  return t('health.scaleSync.notReady')
}

function openVerificationUrl() {
  if (lastResult.value?.verificationUrl) window.open(lastResult.value.verificationUrl, '_blank')
}
</script>

<template>
  <section class="xiaomi-health-settings" data-test="xiaomi-health-settings">
    <div class="settings-card">
      <div class="settings-card-header">
        <div>
          <h3>{{ t('health.scaleSync.settingsTitle') }}</h3>
          <p>{{ t('health.scaleSync.settingsSummary') }}</p>
        </div>
        <span>{{ statusText() }}</span>
      </div>

      <SettingRow :label="t('health.scaleSync.enabled')" :hint="t('health.scaleSync.enabledHint')">
        <NSwitch v-model:value="draft.enabled" :loading="loading || saving" />
      </SettingRow>
      <SettingRow :label="t('health.scaleSync.source')" :hint="t('health.scaleSync.sourceHint')">
        <NSelect v-model:value="draft.source" :options="sourceOptions" size="small" class="input-lg" />
      </SettingRow>
      <SettingRow :label="t('health.scaleSync.username')" :hint="t('health.scaleSync.usernameHint')">
        <NInput v-model:value="draft.username" autocomplete="username" clearable size="small" class="input-lg" />
      </SettingRow>
      <SettingRow :label="t('health.scaleSync.password')" :hint="settings?.hasPassword ? t('health.scaleSync.passwordConfigured') : t('health.scaleSync.passwordHint')">
        <NInput
          v-model:value="draft.password"
          autocomplete="current-password"
          type="password"
          show-password-on="click"
          clearable
          size="small"
          class="input-lg"
          :placeholder="settings?.hasPassword ? settings.passwordMasked : ''"
        />
      </SettingRow>
      <SettingRow :label="t('health.scaleSync.region')" :hint="t('health.scaleSync.regionHint')">
        <NInput v-model:value="draft.region" size="small" class="input-lg" />
      </SettingRow>
      <SettingRow :label="t('health.scaleSync.scaleModel')" :hint="t('health.scaleSync.scaleModelHint')">
        <NInput v-model:value="draft.scaleModel" size="small" class="input-lg" />
      </SettingRow>
      <SettingRow :label="t('health.scaleSync.executor')" :hint="t('health.scaleSync.executorHint')">
        <NInput v-model:value="draft.scaleconnectPath" size="small" class="input-lg" />
      </SettingRow>

      <div class="settings-actions">
        <NButton v-if="lastResult?.verificationUrl" size="small" tertiary @click="openVerificationUrl">
          {{ t('health.scaleSync.openVerification') }}
        </NButton>
        <NButton size="small" type="primary" :loading="saving" @click="saveSettings">
          {{ t('common.save') }}
        </NButton>
        <NButton size="small" secondary :loading="running" @click="runNow">
          {{ t('health.scaleSync.runNow') }}
        </NButton>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.xiaomi-health-settings {
  margin-top: 16px;
}

.settings-card {
  border: 1px solid $border-light;
  border-radius: 8px;
  background: $bg-card;
  padding: 16px;
}

.settings-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;

  h3 {
    margin: 0;
    font-size: 16px;
  }

  p,
  span {
    color: $text-muted;
    font-size: 13px;
  }

  p {
    margin: 4px 0 0;
  }
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid $border-light;
}
</style>
