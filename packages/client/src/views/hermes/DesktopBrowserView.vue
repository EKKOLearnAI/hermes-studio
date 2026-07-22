<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NCard, NInput, NSelect, NSwitch, NTabPane, NTabs, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { desktopBridge, type DesktopBrowserProfile, type DesktopBrowserState } from '@/utils/desktop-bridge'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const bridge = desktopBridge()?.browser
const state = ref<DesktopBrowserState | null>(null)
const settingsProfileId = ref('')
const profileDraft = ref<DesktopBrowserProfile | null>(null)
const profileName = ref('')
const busy = ref(false)
const loadError = ref('')
let stopStateListener: (() => void) | undefined
let unmounting = false

const profileOptions = computed(() => state.value?.profiles.map(profile => ({ label: profile.name, value: profile.id })) || [])
const conflictOptions = computed(() => [
  { label: t('browser.uniquifyDownloads'), value: 'uniquify' },
  { label: t('browser.askOnConflict'), value: 'ask' },
])
const profileDownloads = computed(() => state.value?.downloads.filter(item => item.profileId === settingsProfileId.value) || [])
const profilePermissions = computed(() => state.value?.permissions.filter(item => item.profileId === settingsProfileId.value) || [])

watch(settingsProfileId, profileId => {
  const profile = state.value?.profiles.find(item => item.id === profileId)
  profileDraft.value = profile ? { ...profile, tabs: [...profile.tabs] } : null
})

function applyState(next: DesktopBrowserState): void {
  state.value = next
  if (!settingsProfileId.value || !next.profiles.some(profile => profile.id === settingsProfileId.value)) {
    settingsProfileId.value = next.activeProfileId
  }
}

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  try {
    await action()
  } catch (error) {
    if (!unmounting) message.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

async function switchProfile(profileId: string): Promise<void> {
  if (!bridge || profileId === state.value?.activeProfileId) return
  try {
    const impact = await bridge.profileSwitchImpact()
    if (!impact.requiresConfirmation) return run(() => bridge.switchProfile(profileId))
    dialog.warning({
      title: t('browser.profileSwitchTitle'),
      content: t('browser.profileSwitchWarning', { agents: impact.activeAgentRuns, downloads: impact.activeDownloads, annotations: impact.pendingAnnotations }),
      positiveText: t('common.confirm'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => run(() => bridge.switchProfile(profileId, true)),
    })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function createProfile(): void {
  const name = profileName.value.trim()
  if (!name) return
  void run(async () => {
    const created = await bridge!.createProfile(name)
    profileName.value = ''
    settingsProfileId.value = created.id
  })
}

function chooseDirectory(kind: 'download' | 'session'): void {
  const draft = profileDraft.value
  if (!draft) return
  void run(async () => {
    const updated = await bridge!.chooseDirectory(kind, draft.id)
    if (updated) profileDraft.value = { ...updated, tabs: [...updated.tabs] }
  })
}

function saveProfile(): void {
  const draft = profileDraft.value
  if (!draft) return
  void run(async () => {
    const renamed = await bridge!.renameProfile(draft.id, draft.name)
    const updated = await bridge!.updateProfile(draft.id, {
      askBeforeDownload: draft.askBeforeDownload,
      downloadConflictPolicy: draft.downloadConflictPolicy,
    })
    profileDraft.value = { ...updated, name: renamed.name, tabs: [...updated.tabs] }
    message.success(t('common.saved'))
  })
}

function deleteProfile(profileId: string): void {
  dialog.warning({
    title: t('browser.deleteProfileTitle'),
    content: t('browser.deleteProfileWarning'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => run(() => bridge!.deleteProfile(profileId)),
  })
}

function clearProfileData(kind: 'cache' | 'site-data' | 'permission-audit'): void {
  const profileId = settingsProfileId.value
  if (!profileId) return
  const clear = () => run(async () => {
    await bridge!.clearProfileData(profileId, kind)
    message.success(t('browser.dataCleared'))
  })
  if (kind !== 'site-data') {
    void clear()
    return
  }
  dialog.warning({
    title: t('browser.clearSiteData'),
    content: t('browser.clearSiteDataWarning'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: clear,
  })
}

onMounted(async () => {
  if (!bridge) return
  try {
    const next = await bridge.getState()
    applyState(next)
    stopStateListener = bridge.onStateChange(applyState)
  } catch (error) {
    loadError.value = `${t('browser.loadFailed')}: ${error instanceof Error ? error.message : String(error)}`
    message.error(loadError.value)
  }
})

onUnmounted(() => {
  unmounting = true
  stopStateListener?.()
})
</script>

<template>
  <section class="browser-settings-page">
    <div v-if="!bridge" class="unavailable">{{ t('browser.desktopOnly') }}</div>
    <template v-else>
      <header class="page-header">
        <div>
          <h2>{{ t('browser.title') }}</h2>
          <span>{{ t('browser.settings') }}</span>
        </div>
        <NSelect
          :value="state?.activeProfileId"
          :options="profileOptions"
          :disabled="busy"
          class="active-profile-select"
          @update:value="switchProfile"
        />
      </header>

      <div v-if="loadError" class="unavailable">{{ loadError }}</div>
      <NCard v-else class="settings-card" :bordered="false">
        <NTabs type="line" animated>
          <NTabPane name="profiles" :tab="t('browser.profiles')">
            <div class="create-profile">
              <NInput v-model:value="profileName" :placeholder="t('browser.profileName')" />
              <NButton :disabled="busy" @click="createProfile">{{ t('common.create') }}</NButton>
            </div>
            <div v-if="profileDraft" class="settings-form">
              <label>{{ t('browser.profiles') }}<NSelect v-model:value="settingsProfileId" :options="profileOptions" /></label>
              <label>{{ t('browser.profileName') }}<NInput v-model:value="profileDraft.name" /></label>
              <label>{{ t('browser.profileDirectory') }}<div class="path-row"><NInput v-model:value="profileDraft.sessionPath" readonly /><NButton @click="chooseDirectory('session')">…</NButton></div></label>
              <p v-if="profileDraft.pendingSessionPath" class="hint">{{ t('browser.profileMovePending') }}</p>
              <label>{{ t('browser.downloadDirectory') }}<div class="path-row"><NInput v-model:value="profileDraft.downloadPath" readonly /><NButton @click="chooseDirectory('download')">…</NButton></div></label>
              <label class="switch-row"><span>{{ t('browser.askBeforeDownload') }}</span><NSwitch v-model:value="profileDraft.askBeforeDownload" /></label>
              <label>{{ t('browser.downloadConflictPolicy') }}<NSelect v-model:value="profileDraft.downloadConflictPolicy" :options="conflictOptions" /></label>
              <div class="form-actions">
                <NButton type="primary" :disabled="busy" @click="saveProfile">{{ t('common.save') }}</NButton>
                <NButton v-if="state && state.profiles.length > 1 && profileDraft.id !== state.activeProfileId" type="error" ghost @click="deleteProfile(profileDraft.id)">{{ t('common.delete') }}</NButton>
              </div>
            </div>
          </NTabPane>

          <NTabPane name="downloads" :tab="t('browser.downloads')">
            <label class="profile-filter">{{ t('browser.profiles') }}<NSelect v-model:value="settingsProfileId" :options="profileOptions" /></label>
            <div v-if="!profileDownloads.length" class="empty">{{ t('common.noData') }}</div>
            <div v-for="item in profileDownloads" :key="item.id" class="record"><strong>{{ item.fileName }}</strong><span>{{ item.state }} · {{ item.savePath }}</span></div>
          </NTabPane>

          <NTabPane name="permissions" :tab="t('browser.permissions')">
            <label class="profile-filter">{{ t('browser.profiles') }}<NSelect v-model:value="settingsProfileId" :options="profileOptions" /></label>
            <p class="hint">{{ t('browser.permissionsHint') }}</p>
            <div class="form-actions">
              <NButton @click="clearProfileData('cache')">{{ t('browser.clearCache') }}</NButton>
              <NButton @click="clearProfileData('permission-audit')">{{ t('browser.clearPermissionAudit') }}</NButton>
              <NButton type="error" ghost @click="clearProfileData('site-data')">{{ t('browser.clearSiteData') }}</NButton>
            </div>
            <div v-if="!profilePermissions.length" class="empty">{{ t('common.noData') }}</div>
            <div v-for="item in profilePermissions" :key="item.id" class="record"><strong>{{ item.origin }}</strong><span>{{ item.permission }} · {{ t('browser.blocked') }}</span></div>
          </NTabPane>
        </NTabs>
      </NCard>
    </template>
  </section>
</template>

<style scoped lang="scss">
.browser-settings-page { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--text-color); }
.page-header { min-height: 72px; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--border-color); }
.page-header > div { display: grid; gap: 3px; }.page-header h2 { margin: 0; font-size: 20px; }.page-header span { color: var(--text-color-3); font-size: 12px; }
.active-profile-select { width: min(240px, 40vw); }
.settings-card { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px 20px; }
.settings-card :deep(.n-card__content) { max-width: 820px; width: 100%; margin: 0 auto; }
.create-profile, .path-row, .form-actions { display: flex; align-items: center; gap: 8px; }
.create-profile { max-width: 520px; }.create-profile .n-input, .path-row .n-input { flex: 1; }
.settings-form { display: grid; gap: 14px; margin-top: 20px; }.settings-form label, .profile-filter { display: grid; gap: 6px; font-size: 13px; }.profile-filter { max-width: 320px; margin-bottom: 16px; }
.switch-row { display: flex !important; align-items: center; justify-content: space-between; }
.hint { color: var(--text-color-3); font-size: 12px; }.record { display: grid; gap: 3px; padding: 10px 0; border-bottom: 1px solid var(--border-color); }.record span { color: var(--text-color-3); font-size: 12px; overflow-wrap: anywhere; }.empty, .unavailable { padding: 40px; text-align: center; color: var(--text-color-3); }
@media (max-width: 640px) { .page-header { align-items: stretch; flex-direction: column; }.active-profile-select { width: 100%; }.form-actions { flex-wrap: wrap; } }
</style>
