<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NSpace, NSwitch, NSelect, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import { useSettingsStore } from '@/stores/hermes/settings'
import {
  buildBranchPreview,
  fetchBranchBuildBranches,
  fetchBranchBuildStatus,
  fetchBranchPreviewCapabilities,
  resetBranchPreview,
  type BranchBuildSummary,
  type BranchPreviewCapabilities,
} from '@/api/hermes/dev-mode-branch-builds'
import SettingRow from './SettingRow.vue'

const DEFAULT_REVIEW_BASE = 'main'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()

const loading = ref(false)
const saving = ref(false)
const running = ref(false)
const branchList = ref<string[]>([])
const branchBuild = ref<BranchBuildSummary | null>(null)
const capabilities = ref<BranchPreviewCapabilities | null>(null)
const draftEnabled = ref(false)
const draftReviewBase = ref(DEFAULT_REVIEW_BASE)
const draftPreviewBranch = ref('')
const showAdvancedDetails = ref(false)

const canUseDevMode = computed(() => isStoredSuperAdmin())
const branchPreviewConfigured = computed(() => capabilities.value?.branchPreviewConfigured !== false)
const canListBranches = computed(() => canUseDevMode.value && capabilities.value?.canListBranches !== false)
const capabilityReason = computed(() => capabilities.value?.reason ? t(`settings.dev.capabilityReasons.${capabilities.value.reason}`) : t('settings.dev.capabilityUnavailable'))
const persistedDevEnabled = computed(() => !!settingsStore.dev.enabled)
const canRunPreviewActions = computed(() => canUseDevMode.value && branchPreviewConfigured.value && persistedDevEnabled.value)
const branchOptions = computed(() => branchList.value.map((branch) => ({ label: branch, value: branch })))
const currentPreviewLabel = computed(() => {
  const branch = branchBuild.value?.previewBranch || draftPreviewBranch.value || draftReviewBase.value || '—'
  const status = branchBuild.value?.status || 'idle'
  return `${branch} · ${status}`
})
const hasBuildError = computed(() => branchBuild.value?.status === 'failed' || Boolean(branchBuild.value?.error))
const settingsChanged = computed(() =>
  draftEnabled.value !== persistedDevEnabled.value
  || draftReviewBase.value !== (settingsStore.dev.review_base || DEFAULT_REVIEW_BASE)
  || draftPreviewBranch.value !== (settingsStore.dev.preview_branch || ''),
)

function syncDraftFromStore() {
  draftEnabled.value = !!settingsStore.dev.enabled
  draftReviewBase.value = settingsStore.dev.review_base || DEFAULT_REVIEW_BASE
  draftPreviewBranch.value = settingsStore.dev.preview_branch || ''
}

function ensureSelections() {
  if (!branchList.value.length) return

  if (!draftReviewBase.value || !branchList.value.includes(draftReviewBase.value)) {
    draftReviewBase.value = branchList.value.includes(DEFAULT_REVIEW_BASE)
      ? DEFAULT_REVIEW_BASE
      : branchList.value[0]
  }

  const preferredPreview = branchBuild.value?.previewBranch
    || draftPreviewBranch.value
    || settingsStore.dev.preview_branch
    || branchList.value[0]

  if (!draftPreviewBranch.value || !branchList.value.includes(draftPreviewBranch.value)) {
    draftPreviewBranch.value = preferredPreview && branchList.value.includes(preferredPreview)
      ? preferredPreview
      : branchList.value[0]
  }
}

function statusType(status: BranchBuildSummary['status']) {
  switch (status) {
    case 'running': return 'warning'
    case 'success': return 'success'
    case 'failed': return 'error'
    default: return 'default'
  }
}

function fmtTime(value: number | null) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

watch(() => ({ ...settingsStore.dev }), () => {
  syncDraftFromStore()
}, { immediate: true })

watch(branchList, () => {
  ensureSelections()
})

watch(hasBuildError, (failed) => {
  if (failed) {
    showAdvancedDetails.value = true
  }
}, { immediate: true })

async function refreshCapabilities() {
  if (!canUseDevMode.value) return null
  try {
    capabilities.value = await fetchBranchPreviewCapabilities()
    return capabilities.value
  } catch (err: any) {
    capabilities.value = {
      isSuperAdmin: true,
      devModeAvailable: true,
      branchPreviewAvailable: false,
      branchPreviewConfigured: false,
      canListBranches: false,
      canBuild: false,
      reason: 'not_git_repo',
    }
    message.error(err?.message || t('settings.dev.loadFailed'))
    return capabilities.value
  }
}

async function refreshBranches() {
  if (!canListBranches.value) return
  loading.value = true
  try {
    branchList.value = await fetchBranchBuildBranches()
    ensureSelections()
  } catch (err: any) {
    message.error(err?.message || t('settings.dev.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function refreshStatus() {
  if (!canUseDevMode.value) return
  loading.value = true
  try {
    const caps = await refreshCapabilities()
    if (caps && !caps.branchPreviewConfigured) {
      branchBuild.value = null
      branchList.value = []
      return
    }
    const [status, branches] = await Promise.all([
      fetchBranchBuildStatus(),
      fetchBranchBuildBranches(),
    ])
    branchBuild.value = status
    branchList.value = branches
    if (status.reviewBase) {
      draftReviewBase.value = status.reviewBase
    }
    if (status.previewBranch) {
      draftPreviewBranch.value = status.previewBranch
    }
    ensureSelections()
  } catch (err: any) {
    message.error(err?.message || t('settings.dev.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function saveDevSettings() {
  if (!canUseDevMode.value) return
  saving.value = true
  try {
    await settingsStore.saveSection('dev', {
      enabled: draftEnabled.value,
      review_base: draftReviewBase.value,
      preview_branch: draftPreviewBranch.value,
    })
    syncDraftFromStore()
    message.success(t('settings.saved'))
    await refreshStatus()
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function buildSelectedBranch() {
  if (!draftPreviewBranch.value) {
    message.warning(t('settings.dev.branchRequired'))
    return
  }
  running.value = true
  try {
    const result = await buildBranchPreview(draftPreviewBranch.value)
    branchBuild.value = result
    draftPreviewBranch.value = result.previewBranch || draftPreviewBranch.value
    draftReviewBase.value = result.reviewBase || draftReviewBase.value
    settingsStore.updateLocal('dev', {
      preview_branch: draftPreviewBranch.value,
      review_base: draftReviewBase.value,
    })
    message.success(t('settings.dev.buildStarted'))
    await refreshStatus()
  } catch (err: any) {
    message.error(err?.message || t('settings.dev.buildFailed'))
  } finally {
    running.value = false
  }
}

async function resetToReviewBase() {
  running.value = true
  try {
    const result = await resetBranchPreview()
    branchBuild.value = result
    draftPreviewBranch.value = result.previewBranch || draftReviewBase.value
    draftReviewBase.value = result.reviewBase || draftReviewBase.value
    settingsStore.updateLocal('dev', {
      preview_branch: draftPreviewBranch.value,
      review_base: draftReviewBase.value,
    })
    message.success(t('settings.dev.resetDone'))
    await refreshStatus()
  } catch (err: any) {
    message.error(err?.message || t('settings.dev.resetFailed'))
  } finally {
    running.value = false
  }
}

onMounted(async () => {
  await refreshStatus()
})
</script>

<template>
  <section v-if="canUseDevMode" class="settings-section dev-mode-settings">
    <div class="developer-tools-header">
      <h3>{{ t('settings.dev.developerToolsTitle') }}</h3>
      <p>{{ t('settings.dev.developerToolsHint') }}</p>
    </div>

    <NAlert
      v-if="capabilities && !branchPreviewConfigured"
      type="info"
      class="dev-warning"
      :title="t('settings.dev.notConfiguredTitle')"
    >
      {{ capabilityReason }}
    </NAlert>

    <template v-else>
      <NAlert type="warning" class="dev-warning" :title="t('settings.dev.warningTitle')">
        {{ t('settings.dev.warningBody') }}
      </NAlert>

      <SettingRow :label="t('settings.dev.enabled')" :hint="t('settings.dev.enabledHint')">
        <NSwitch
          v-model:value="draftEnabled"
          :disabled="!canUseDevMode"
        />
      </SettingRow>

      <NAlert v-if="canUseDevMode && !persistedDevEnabled" type="info" class="dev-disabled-note">
        {{ t('settings.dev.disabledNote') }}
      </NAlert>

      <NCard size="small" class="branch-preview-card" :title="t('settings.dev.branchPreviewTitle')">
      <template #header-extra>
        <NTag :type="statusType(branchBuild?.status || 'idle')" size="small">
          {{ branchBuild?.status || 'idle' }}
        </NTag>
      </template>

      <div class="branch-preview-grid">
        <SettingRow :label="t('settings.dev.branchToPreview')" :hint="t('settings.dev.branchToPreviewHint')">
          <NSelect
            v-model:value="draftPreviewBranch"
            filterable
            clearable
            size="small"
            class="input-lg"
            :loading="loading"
            :options="branchOptions"
            :placeholder="t('settings.dev.branchToPreviewPlaceholder')"
            :disabled="running"
          />
        </SettingRow>

        <div class="current-preview-block">
          <div class="current-preview-label">{{ t('settings.dev.currentPreview') }}</div>
          <div class="current-preview-value">{{ currentPreviewLabel }}</div>
        </div>
      </div>

      <div class="actions actions-primary">
        <NSpace>
          <NButton type="primary" :loading="saving" :disabled="!canUseDevMode || !settingsChanged" @click="saveDevSettings">
            {{ t('common.save') }}
          </NButton>
          <NButton type="info" :loading="running" :disabled="!canRunPreviewActions || !draftPreviewBranch || !branchList.length" @click="buildSelectedBranch">
            {{ t('settings.dev.buildPreview') }}
          </NButton>
          <NButton :loading="running" :disabled="!canRunPreviewActions" @click="resetToReviewBase">
            {{ t('settings.dev.resetToBase') }}
          </NButton>
        </NSpace>
      </div>

      <button class="advanced-summary" type="button" @click="showAdvancedDetails = !showAdvancedDetails">
        {{ t('settings.dev.advancedDetails') }}
        <span class="advanced-summary-caret">{{ showAdvancedDetails ? '▾' : '▸' }}</span>
      </button>

      <div v-if="showAdvancedDetails" class="advanced-content">
        <SettingRow :label="t('settings.dev.baseBranch')" :hint="t('settings.dev.baseBranchHint')">
          <NSelect
            v-model:value="draftReviewBase"
            filterable
            size="small"
            class="input-lg"
            :loading="loading"
            :options="branchOptions"
            :placeholder="t('settings.dev.baseBranchPlaceholder')"
            :disabled="!canUseDevMode || running"
          />
        </SettingRow>

        <div class="actions actions-secondary">
          <NSpace>
            <NButton :loading="loading" :disabled="!canUseDevMode || running" @click="refreshBranches">
              {{ t('settings.dev.refreshBranches') }}
            </NButton>
            <NButton :loading="loading" :disabled="!canUseDevMode || running" @click="refreshStatus">
              {{ t('settings.dev.refreshStatus') }}
            </NButton>
          </NSpace>
        </div>

        <div class="meta-grid">
          <div><strong>{{ t('settings.dev.worktreePath') }}:</strong> {{ branchBuild?.previewWorktreePath || '—' }}</div>
          <div><strong>{{ t('settings.dev.startedAt') }}:</strong> {{ fmtTime(branchBuild?.startedAt || null) }}</div>
          <div><strong>{{ t('settings.dev.finishedAt') }}:</strong> {{ fmtTime(branchBuild?.finishedAt || null) }}</div>
          <div><strong>{{ t('settings.dev.exitCode') }}:</strong> {{ branchBuild?.exitCode ?? '—' }}</div>
          <div><strong>{{ t('settings.dev.signal') }}:</strong> {{ branchBuild?.signal || '—' }}</div>
        </div>

        <div v-if="branchBuild?.error" class="error-block">
          <strong>{{ t('settings.dev.lastError') }}:</strong> {{ branchBuild.error }}
        </div>

        <pre class="log-tail">{{ branchBuild?.logTail?.join('\n') || t('settings.dev.noLogs') }}</pre>
      </div>
      </NCard>
    </template>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.developer-tools-header {
  margin-bottom: 16px;

  h3 {
    margin: 0 0 4px;
    font-size: 16px;
    color: $text-primary;
  }

  p {
    margin: 0;
    font-size: 13px;
    color: $text-muted;
  }
}

.dev-warning,
.dev-disabled-note {
  margin-bottom: 16px;
}

.branch-preview-card {
  margin-top: 16px;
}

.branch-preview-grid {
  display: grid;
  gap: 12px;
}

.current-preview-block {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.03);
}

.current-preview-label {
  font-size: 12px;
  color: $text-muted;
}

.current-preview-value {
  font-size: 14px;
  color: $text-primary;
  font-weight: 600;
  word-break: break-word;
}

.actions {
  margin-top: 12px;
}

.actions-secondary {
  margin-top: 16px;
}

.advanced-summary {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  margin-top: 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: $text-primary;
}

.advanced-summary-caret {
  font-size: 12px;
  color: $text-muted;
}

.advanced-content {
  margin-top: 12px;
  display: grid;
  gap: 12px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  font-size: 12px;
  color: $text-primary;
}

.error-block {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(220, 38, 38, 0.08);
  color: $text-primary;
  white-space: pre-wrap;
  word-break: break-word;
}

.log-tail {
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.04);
  white-space: pre-wrap;
  overflow: auto;
  max-height: 240px;
  font-size: 12px;
  line-height: 1.5;
}

:deep(.n-input-group-label) {
  min-width: 120px;
}
</style>
