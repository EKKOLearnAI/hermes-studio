<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NSpace, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import { fetchBranchBuildStatus, fetchBranchPreviewCapabilities, type BranchBuildSummary, type BranchPreviewCapabilities } from '@/api/hermes/dev-mode-branch-builds'
import { useAppStore } from '@/stores/hermes/app'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const settingsStore = useSettingsStore()
const router = useRouter()
const message = useMessage()
const { t } = useI18n()

const loading = ref(false)
const previewLoading = ref(false)
const previewCapabilities = ref<BranchPreviewCapabilities | null>(null)
const previewStatus = ref<BranchBuildSummary | null>(null)

const canUseDevMode = computed(() => isStoredSuperAdmin())
const devModeEnabled = computed(() => !!settingsStore.dev.enabled)
const previewConfigured = computed(() => previewCapabilities.value?.branchPreviewConfigured !== false)
const currentStableVersion = computed(() => appStore.serverVersion || '—')
const latestReleaseVersion = computed(() => appStore.latestVersion || '—')
const hasLatestRelease = computed(() => !!appStore.latestVersion)
const releaseStatusText = computed(() => {
  if (!appStore.connected) return t('updates.sourceUnavailable')
  if (appStore.updateAvailable) return t('updates.updateAvailable')
  return t('updates.upToDate')
})
const previewSummaryText = computed(() => {
  if (!canUseDevMode.value) return t('updates.previewUnavailable')
  if (!devModeEnabled.value) return t('updates.previewDisabled')
  if (!previewConfigured.value) return t('updates.previewUnavailable')
  if (!previewStatus.value) return t('updates.previewUnavailable')
  const branch = previewStatus.value.previewBranch || '—'
  const status = previewStatus.value.status || 'idle'
  return `${branch} · ${status}`
})
const previewTagType = computed(() => {
  if (!canUseDevMode.value || !devModeEnabled.value || !previewConfigured.value || !previewStatus.value) return 'default'
  switch (previewStatus.value.status) {
    case 'running': return 'warning'
    case 'success': return 'success'
    case 'failed': return 'error'
    default: return 'default'
  }
})

function fmtTime(value: number | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

async function refreshPreviewStatus() {
  if (!canUseDevMode.value) {
    previewCapabilities.value = null
    previewStatus.value = null
    return
  }

  previewLoading.value = true
  try {
    const capabilities = await fetchBranchPreviewCapabilities()
    previewCapabilities.value = capabilities
    if (capabilities.branchPreviewConfigured && settingsStore.dev.enabled) {
      previewStatus.value = await fetchBranchBuildStatus()
    } else {
      previewStatus.value = null
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
    message.error(err?.message || t('updates.loadFailed'))
  } finally {
    previewLoading.value = false
  }
}

async function refreshAll(showError = true) {
  loading.value = true
  try {
    await Promise.all([
      settingsStore.fetchSettings(),
      appStore.checkConnection(),
      refreshPreviewStatus(),
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
    await appStore.checkConnection()
  } else {
    message.error(t('updates.updateFailed'))
  }
}

function openDevModeSettings() {
  router.push({ name: 'hermes.settings', query: { tab: 'dev' } })
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
          {{ appStore.updating ? t('updates.updating') : t('updates.updateNow') }}
        </NButton>
      </div>
    </header>

    <NSpin :show="loading && !currentStableVersion" class="updates-spin">
      <main class="updates-content">
        <section class="updates-grid">
          <NCard size="small" class="updates-card" :title="t('updates.currentStableTitle')">
            <template #header-extra>
              <NTag :type="appStore.connected ? 'success' : 'error'" size="small">
                {{ appStore.connected ? t('updates.connected') : t('updates.disconnected') }}
              </NTag>
            </template>

            <div class="card-stack">
              <div class="metric-row">
                <span>{{ t('updates.installedVersion') }}</span>
                <strong>{{ currentStableVersion }}</strong>
              </div>
              <div class="metric-row">
                <span>{{ t('updates.updateStatus') }}</span>
                <strong>{{ releaseStatusText }}</strong>
              </div>
              <NAlert v-if="!appStore.connected" type="warning" :title="t('updates.sourceUnavailableTitle')">
                {{ t('updates.sourceUnavailableBody') }}
              </NAlert>
            </div>
          </NCard>

          <NCard size="small" class="updates-card" :title="t('updates.latestReleaseTitle')">
            <template #header-extra>
              <NTag :type="hasLatestRelease ? 'info' : 'default'" size="small">
                {{ hasLatestRelease ? t('updates.latestReleaseAvailable') : t('updates.unavailable') }}
              </NTag>
            </template>

            <div class="card-stack">
              <div class="metric-row">
                <span>{{ t('updates.latestReleaseVersion') }}</span>
                <strong>{{ latestReleaseVersion }}</strong>
              </div>
              <p class="card-copy">{{ t('updates.latestReleaseBody') }}</p>
              <NAlert v-if="!hasLatestRelease" type="info" :title="t('updates.unavailable')">
                {{ t('updates.latestReleaseUnavailable') }}
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
              <NAlert v-if="!canUseDevMode || !devModeEnabled || !previewConfigured" type="info" :title="t('updates.previewUnavailableTitle')">
                {{ !canUseDevMode
                  ? t('updates.previewSuperAdminRequired')
                  : !devModeEnabled
                    ? t('updates.previewDisabled')
                    : t('updates.previewUnavailable') }}
              </NAlert>
              <div v-else class="preview-meta">
                <div class="metric-row">
                  <span>{{ t('updates.previewBranch') }}</span>
                  <strong>{{ previewStatus?.previewBranch || '—' }}</strong>
                </div>
                <div class="metric-row">
                  <span>{{ t('updates.previewBaseBranch') }}</span>
                  <strong>{{ previewStatus?.reviewBase || '—' }}</strong>
                </div>
                <div class="metric-row">
                  <span>{{ t('updates.previewStartedAt') }}</span>
                  <strong>{{ fmtTime(previewStatus?.startedAt) }}</strong>
                </div>
              </div>
              <NButton v-if="canUseDevMode" secondary size="small" @click="openDevModeSettings">
                {{ t('updates.openDevMode') }}
              </NButton>
            </div>
          </NCard>


          <NCard size="small" class="updates-card" :title="t('updates.recoveryTitle')">
            <div class="card-stack">
              <p class="card-copy">{{ t('updates.recoveryBody') }}</p>
              <NAlert type="info" :title="t('updates.recoveryHintTitle')">
                {{ t('updates.recoveryHintBody') }}
              </NAlert>
              <NSpace>
                <NButton :disabled="!appStore.clientOutdated" @click="appStore.reloadClient()">
                  {{ t('updates.reloadClient') }}
                </NButton>
                <NButton :disabled="!appStore.updateAvailable" type="primary" :loading="appStore.updating" @click="handleUpdateNow">
                  {{ t('updates.updateNow') }}
                </NButton>
              </NSpace>
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

.preview-meta {
  display: grid;
  gap: 8px;
}
</style>
