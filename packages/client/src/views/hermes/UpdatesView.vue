<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NSelect, NSwitch, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import {
  buildBranchPreview,
  fetchBranchBuildBranches,
  fetchBranchBuildStatus,
  fetchBranchPreviewCapabilities,
  promoteBranchPreview,
  restoreLatestUpstreamRelease,
  type BranchBuildSummary,
  type BranchPreviewCapabilities,
} from '@/api/hermes/dev-mode-branch-builds'
import { useAppStore } from '@/stores/hermes/app'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()

type PreviewSourceKind = 'release' | 'branch' | 'commit'

const loading = ref(false)
const previewLoading = ref(false)
const previewActionLoading = ref(false)
const devModeSaving = ref(false)
const stableLastCheckedAt = ref<number | null>(null)
const previewCapabilities = ref<BranchPreviewCapabilities | null>(null)
const previewStatus = ref<BranchBuildSummary | null>(null)
const previewBranches = ref<string[]>([])
const previewSourceKind = ref<PreviewSourceKind>('release')
const previewBranchRef = ref('')
const previewCommitRef = ref('')

const canUseDevMode = computed(() => isStoredSuperAdmin())
const devModeEnabled = ref(false)
const previewConfigured = computed(() => previewCapabilities.value?.branchPreviewConfigured !== false)
const currentStableVersion = computed(() => appStore.serverVersion || '—')
const latestReleaseVersion = computed(() => appStore.latestVersion || '—')
const hasLatestRelease = computed(() => !!appStore.latestVersion)
const previewReady = computed(() => previewStatus.value?.status === 'success')
const previewRunning = computed(() => previewStatus.value?.status === 'running')
const previewFailed = computed(() => previewStatus.value?.status === 'failed')
const previewUrl = computed(() => previewStatus.value?.previewUrl || '/preview/')
const previewLogs = computed(() => previewStatus.value?.logTail?.join('\n') || t('settings.dev.noLogs'))
const stableStatusText = computed(() => {
  if (!appStore.connected) return t('updates.sourceUnavailable')
  if (appStore.updateAvailable) return t('updates.updateAvailable')
  return t('updates.upToDate')
})
const stableStatusType = computed(() => {
  if (!appStore.connected) return 'error'
  if (appStore.updateAvailable) return 'warning'
  return 'success'
})
const stableLastCheckedText = computed(() => fmtTime(stableLastCheckedAt.value))
const updateStableLabel = computed(() => {
  if (hasLatestRelease.value) return t('updates.updateStableTo', { version: latestReleaseVersion.value })
  return t('updates.updateNow')
})
const previewSummaryText = computed(() => {
  if (!canUseDevMode.value) return t('updates.previewUnavailable')
  if (!previewConfigured.value) return t('updates.previewUnavailable')
  if (!previewStatus.value) return 'idle'
  return previewStatus.value.status || 'idle'
})
const previewTagType = computed(() => {
  if (!canUseDevMode.value || !previewConfigured.value || !previewStatus.value) return 'default'
  switch (previewStatus.value.status) {
    case 'running': return 'warning'
    case 'success': return 'success'
    case 'failed': return 'error'
    default: return 'default'
  }
})
const previewSourceOptions = computed<Array<{ label: string, value: PreviewSourceKind }>>(() => {
  const options: Array<{ label: string, value: PreviewSourceKind }> = [{ label: 'Release', value: 'release' }]
  if (devModeEnabled.value) {
    options.push(
      { label: 'Branch', value: 'branch' },
      { label: 'Commit', value: 'commit' },
    )
  }
  return options
})
const branchOptions = computed(() => {
  const branches = new Set(previewBranches.value)
  const currentBranch = previewStatus.value?.previewBranch || previewStatus.value?.buildBranch
  if (currentBranch) branches.add(currentBranch)
  return [...branches]
    .sort((a, b) => a.localeCompare(b))
    .map((branch) => ({ label: branch, value: branch }))
})
const currentPreviewSourceLabel = computed(() => {
  if (previewSourceKind.value === 'release') return 'Release'
  if (previewSourceKind.value === 'branch') return 'Branch'
  return 'Commit'
})
const previewModeCopy = computed(() => t('updates.previewStableCopy'))
const canBuildPreview = computed(() => {
  if (!canUseDevMode.value || !previewConfigured.value) return false
  if (previewSourceKind.value === 'release') return true
  if (!devModeEnabled.value) return false
  if (previewSourceKind.value === 'branch') return Boolean(previewBranchRef.value)
  return Boolean(previewCommitRef.value)
})

watch(devModeEnabled, (enabled) => {
  if (!enabled && previewSourceKind.value !== 'release') {
    previewSourceKind.value = 'release'
  }
})

function fmtTime(value: number | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function statusLabel(status: BranchBuildSummary['status'] | null | undefined) {
  switch (status) {
    case 'running': return 'running'
    case 'success': return 'ready'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    default: return 'idle'
  }
}

function ensureBranchSelection() {
  if (!previewBranches.value.length) return
  if (!previewBranchRef.value || !previewBranches.value.includes(previewBranchRef.value)) {
    previewBranchRef.value = previewBranches.value[0]
  }
}

async function handleDevModeToggle(enabled: boolean) {
  if (!canUseDevMode.value) return
  devModeSaving.value = true
  try {
    await settingsStore.saveSection('dev', {
      enabled,
      review_base: settingsStore.dev.review_base,
      preview_branch: settingsStore.dev.preview_branch,
    })
    devModeEnabled.value = enabled
    message.success(t('settings.saved'))
    await refreshPreviewStatus(enabled)
  } catch (err: any) {
    message.error(err?.message || t('updates.loadFailed'))
  } finally {
    devModeSaving.value = false
  }
}

async function refreshPreviewStatus(forceDevModeEnabled = devModeEnabled.value) {
  if (!canUseDevMode.value) {
    previewCapabilities.value = null
    previewStatus.value = null
    previewBranches.value = []
    return
  }

  previewLoading.value = true
  try {
    const capabilities = await fetchBranchPreviewCapabilities()
    previewCapabilities.value = capabilities
    if (!capabilities.branchPreviewConfigured) {
      previewStatus.value = null
      previewBranches.value = []
      return
    }

    const tasks: Promise<any>[] = [fetchBranchBuildStatus()]
    if (forceDevModeEnabled && capabilities.canListBranches) {
      tasks.push(fetchBranchBuildBranches())
    }

    const [status, branches] = await Promise.all(tasks)
    previewStatus.value = status
    previewBranchRef.value = status.previewBranch || status.buildBranch || previewBranchRef.value
    if (Array.isArray(branches)) {
      previewBranches.value = [...branches].sort((a, b) => a.localeCompare(b))
      ensureBranchSelection()
    }
  } catch (err: any) {
    previewCapabilities.value = {
      isSuperAdmin: true,
      devModeAvailable: true,
      branchPreviewAvailable: false,
      branchPreviewConfigured: false,
      canListBranches: false,
      canBuild: false,
      reason: 'not_git_repo',
    }
    previewStatus.value = null
    previewBranches.value = []
    message.error(err?.message || t('updates.loadFailed'))
  } finally {
    previewLoading.value = false
  }
}

async function refreshStableStatus() {
  await appStore.checkConnection()
  stableLastCheckedAt.value = Date.now()
}

async function refreshAll(showError = true) {
  loading.value = true
  try {
    await settingsStore.fetchSettings()
    devModeEnabled.value = !!settingsStore.dev.enabled
    await Promise.all([
      refreshStableStatus(),
      refreshPreviewStatus(devModeEnabled.value),
    ])
  } catch (err: any) {
    if (showError) message.error(err?.message || t('updates.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function handleUpdateNow() {
  if (!appStore.updateAvailable) return
  const ok = await appStore.doUpdate()
  if (ok) {
    message.success(t('updates.updateStarted'))
    await refreshStableStatus()
  } else {
    message.error(t('updates.updateFailed'))
  }
}

async function handleBuildPreview() {
  if (!canBuildPreview.value) return

  previewActionLoading.value = true
  try {
    if (previewSourceKind.value === 'release') {
      await restoreLatestUpstreamRelease()
    } else {
      const sourceRef = previewSourceKind.value === 'branch'
        ? previewBranchRef.value.trim()
        : previewCommitRef.value.trim()
      if (!sourceRef) {
        message.warning(previewSourceKind.value === 'branch' ? t('settings.dev.branchRequired') : 'Please enter a commit first')
        return
      }
      await buildBranchPreview(sourceRef)
    }

    message.success('Preview build started')
    await refreshPreviewStatus()
  } catch (err: any) {
    message.error(err?.message || t('settings.dev.buildFailed'))
  } finally {
    previewActionLoading.value = false
  }
}

async function handlePromotePreview() {
  if (!previewReady.value) return
  previewActionLoading.value = true
  try {
    await promoteBranchPreview()
    message.success(t('settings.dev.promotePreviewDone'))
    await refreshPreviewStatus()
  } catch (err: any) {
    message.error(err?.message || t('settings.dev.promotePreviewFailed'))
  } finally {
    previewActionLoading.value = false
  }
}

function openPreview() {
  if (!previewUrl.value || typeof window === 'undefined') return
  window.open(previewUrl.value, '_blank', 'noreferrer')
}

onMounted(() => {
  void refreshAll()
})
</script>

<template>
  <div class="updates-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ t('updates.title') }}</h2>
        <p class="header-subtitle">{{ t('updates.subtitle') }}</p>
      </div>
      <div class="header-actions">
        <NButton size="small" :loading="loading || previewLoading" @click="refreshAll(false)">
          {{ t('updates.refresh') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="!appStore.updateAvailable"
          :loading="appStore.updating"
          @click="handleUpdateNow"
        >
          {{ appStore.updating ? t('updates.updating') : updateStableLabel }}
        </NButton>
      </div>
    </header>

    <NSpin :show="loading && !currentStableVersion" class="updates-spin">
      <main class="updates-content">
        <section class="updates-grid">
          <NCard size="small" class="updates-card" :title="t('updates.currentStableTitle')">
            <template #header-extra>
              <NTag :type="stableStatusType" size="small">
                {{ stableStatusText }}
              </NTag>
            </template>

            <div class="card-stack">
              <div class="metric-row">
                <span>{{ t('updates.installedVersion') }}</span>
                <strong>{{ currentStableVersion }}</strong>
              </div>
              <div class="metric-row">
                <span>{{ t('updates.latestReleaseVersion') }}</span>
                <strong>{{ latestReleaseVersion }}</strong>
              </div>
              <div class="metric-row">
                <span>{{ t('updates.updateStatus') }}</span>
                <strong>{{ stableStatusText }}</strong>
              </div>
              <div class="metric-row">
                <span>{{ t('updates.lastChecked') }}</span>
                <strong>{{ stableLastCheckedText }}</strong>
              </div>
              <NAlert v-if="!appStore.connected" type="warning" :title="t('updates.sourceUnavailableTitle')">
                {{ t('updates.sourceUnavailableBody') }}
              </NAlert>
            </div>
          </NCard>

          <NCard v-if="canUseDevMode" size="small" class="updates-card" :title="t('updates.previewTitle')">
            <template #header-extra>
              <NTag :type="previewTagType" size="small">
                {{ previewSummaryText }}
              </NTag>
            </template>

            <div class="card-stack">
              <p class="card-copy">{{ t('updates.previewBody') }}</p>
              <p class="card-copy preview-mode-copy">{{ previewModeCopy }}</p>

              <NAlert v-if="!previewConfigured" type="info" :title="t('updates.previewUnavailableTitle')">
                {{ t('updates.previewUnavailable') }}
              </NAlert>

              <template v-else>
                <NAlert v-if="canUseDevMode" type="warning" :title="t('settings.dev.warningTitle')">
                  {{ t('settings.dev.warningBody') }}
                </NAlert>

                <div v-if="canUseDevMode" class="field-row dev-mode-row">
                  <span>{{ t('settings.dev.enabled') }}</span>
                  <NSwitch
                    :value="devModeEnabled"
                    :loading="devModeSaving"
                    :disabled="devModeSaving"
                    @update:value="handleDevModeToggle"
                  />
                </div>

                <NAlert v-if="canUseDevMode && !devModeEnabled" type="info" :title="t('updates.previewUnavailableTitle')">
                  {{ t('settings.dev.disabledNote') }}
                </NAlert>

                <div class="field-grid">
                  <div class="metric-row">
                    <span>Source</span>
                    <strong>{{ currentPreviewSourceLabel }}</strong>
                  </div>

                  <div class="field-row">
                    <span>Source type</span>
                    <NSelect
                      v-model:value="previewSourceKind"
                      size="small"
                      :options="previewSourceOptions"
                      :disabled="previewActionLoading"
                    />
                  </div>

                  <div v-if="previewSourceKind === 'branch'" class="field-row">
                    <span>{{ t('settings.dev.branchToPreview') }}</span>
                    <NSelect
                      v-model:value="previewBranchRef"
                      filterable
                      clearable
                      size="small"
                      :loading="previewLoading"
                      :options="branchOptions"
                      :placeholder="t('settings.dev.branchToPreviewPlaceholder')"
                      :disabled="previewActionLoading || !devModeEnabled"
                    />
                    <small class="field-hint">{{ t('settings.dev.branchToPreviewHint') }}</small>
                  </div>

                  <div v-else-if="previewSourceKind === 'commit'" class="field-row">
                    <span>Commit</span>
                    <input
                      v-model="previewCommitRef"
                      class="text-input"
                      type="text"
                      placeholder="Enter commit hash"
                      :disabled="previewActionLoading || !devModeEnabled"
                    >
                    <small class="field-hint">Dev Mode exposes commit sources for targeted candidate builds.</small>
                  </div>
                </div>

                <div class="metric-row">
                  <span>Current preview</span>
                  <strong>{{ statusLabel(previewStatus?.status) }}</strong>
                </div>
                <div class="metric-row">
                  <span>Built at</span>
                  <strong>{{ fmtTime(previewStatus?.finishedAt || previewStatus?.startedAt || null) }}</strong>
                </div>
                <div class="metric-row">
                  <span>{{ t('settings.dev.previewUrl') }}</span>
                  <strong>
                    <button class="preview-link-button" type="button" :disabled="!previewUrl" @click="openPreview">
                      {{ previewUrl }}
                    </button>
                  </strong>
                </div>

                <div class="actions-row">
                  <NButton type="info" :loading="previewActionLoading" :disabled="!canBuildPreview" @click="handleBuildPreview">
                    {{ t('settings.dev.buildPreview') }}
                  </NButton>
                  <NButton v-if="previewReady" type="primary" :loading="previewActionLoading" @click="handlePromotePreview">
                    Preview -> Stable
                  </NButton>
                  <NButton v-if="previewReady" :disabled="!previewUrl" @click="openPreview">
                    Open preview
                  </NButton>
                </div>

                <div class="log-block">
                  <div class="metric-row log-title-row">
                    <span>Build logs</span>
                    <strong v-if="previewRunning">building</strong>
                    <strong v-else-if="previewFailed">failed</strong>
                    <strong v-else>{{ previewStatus ? previewStatus.status : 'idle' }}</strong>
                  </div>
                  <pre class="log-tail">{{ previewLogs }}</pre>
                </div>

                <NAlert v-if="previewFailed && previewStatus?.error" type="error" :title="t('settings.dev.lastError')">
                  {{ previewStatus.error }}
                </NAlert>
              </template>
            </div>
          </NCard>
        </section>
      </main>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.updates-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.updates-spin {
  flex: 1;
  min-height: 0;
}

.updates-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  padding: 20px 20px 0;
}

.header-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: $text-primary;
}

.header-subtitle {
  margin: 6px 0 0;
  color: $text-muted;
  font-size: 13px;
  max-width: 60ch;
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.updates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.updates-card {
  height: 100%;
}

.card-stack {
  display: grid;
  gap: 12px;
}

.card-copy {
  margin: 0;
  color: $text-muted;
  font-size: 13px;
  line-height: 1.5;
}

.metric-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: baseline;

  span {
    color: $text-muted;
    font-size: 12px;
  }

  strong {
    color: $text-primary;
    font-size: 14px;
    word-break: break-word;
    text-align: right;
  }
}

.field-grid {
  display: grid;
  gap: 12px;
}

.field-row {
  display: grid;
  gap: 8px;

  > span {
    color: $text-muted;
    font-size: 12px;
  }
}

.field-hint {
  color: $text-muted;
  font-size: 12px;
  line-height: 1.4;
}

.text-input {
  width: 100%;
  border: 1px solid rgba(127, 127, 127, 0.3);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  background: transparent;
  color: $text-primary;
}

.preview-link-button {
  border: 0;
  background: transparent;
  color: $accent-primary;
  padding: 0;
  cursor: pointer;
  text-align: right;
  font: inherit;
}

.preview-link-button:disabled {
  cursor: default;
  color: $text-muted;
}

.actions-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.log-block {
  display: grid;
  gap: 8px;
}

.log-title-row strong {
  text-transform: capitalize;
}

.log-tail {
  margin: 0;
  padding: 12px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.08);
  color: $text-primary;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 56px;
}
</style>
