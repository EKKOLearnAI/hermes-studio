<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NSelect, NSwitch, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import {
  buildBranchPreview,
  fetchAvailableReleases,
  fetchBranchBuildBranches,
  fetchBranchBuildStatus,
  fetchBranchPreviewCapabilities,
  promoteBranchPreview,
  restoreLatestUpstreamRelease,
  savePreviewRepository,
  type BranchBuildSummary,
  type BranchPreviewCapabilities,
  type PreviewSourceCapability,
  type PreviewRepositoryDescriptor,
  type PreviewSourceKind,
} from '@/api/hermes/dev-mode-branch-builds'
import { useAppStore } from '@/stores/hermes/app'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()


const loading = ref(false)
const previewLoading = ref(false)
const previewActionLoading = ref(false)
const devModeSaving = ref(false)
const stableLastCheckedAt = ref<number | null>(null)
const previewCapabilities = ref<BranchPreviewCapabilities | null>(null)
const previewStatus = ref<BranchBuildSummary | null>(null)
const previewBranches = ref<string[]>([])
const availableReleases = ref<string[]>([])
const previewSourceKind = ref<PreviewSourceKind>('release')
const previewBranchRef = ref('')
const previewCommitRef = ref('')
const releaseVersionRef = ref('')
const repositorySaving = ref(false)
const repoType = ref<PreviewRepositoryDescriptor['type']>('git-url')
const repoLocalPath = ref('')
const repoGitUrl = ref('')
const repoGithubOwnerRepo = ref('')
const logsExpanded = ref(false)
const canUseDevMode = computed(() => isStoredSuperAdmin())
const devModeEnabled = ref(false)
const previewSourceCapabilities = computed<Record<PreviewSourceKind, PreviewSourceCapability>>(() => {
  const known = new Map((previewCapabilities.value?.providers || []).map(entry => [entry.provider, entry]))
  const release = known.get('release') || {
    provider: 'release',
    available: !!appStore.latestVersion,
    configured: !!appStore.latestVersion,
    devOnly: false,
    canListTargets: !!appStore.latestVersion,
    canBuild: !!appStore.latestVersion,
    reason: null,
  }
  const branch = known.get('branch') || {
    provider: 'branch',
    available: false,
    configured: false,
    devOnly: true,
    canListTargets: false,
    canBuild: false,
    reason: null,
  }
  const commit = known.get('commit') || {
    provider: 'commit',
    available: false,
    configured: false,
    devOnly: true,
    canListTargets: false,
    canBuild: false,
    reason: null,
  }
  return { release, branch, commit }
})
const releasePreviewAvailable = computed(() => previewSourceCapabilities.value.release.available)
const branchPreviewAvailable = computed(() => previewSourceCapabilities.value.branch.available)
const commitPreviewAvailable = computed(() => previewSourceCapabilities.value.commit.available)
const releaseOptions = computed(() => {
  const releases = new Set(availableReleases.value)
  if (latestReleaseVersion.value !== '—') releases.add(latestReleaseVersion.value)
  const current = currentPreviewReleaseVersion.value
  return [...releases]
    .filter(version => version.trim())
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
    .map((version) => {
      const labels: string[] = []
      if (version === latestReleaseVersion.value) labels.push('latest')
      if (current && version === current) labels.push('current')
      return { label: labels.length ? `${version} (${labels.join(', ')})` : version, value: version }
    })
})
const latestReleaseVersion = computed(() => appStore.latestVersion || '—')
const selectedReleaseVersion = computed(() => releaseVersionRef.value || releaseOptions.value[0]?.value || '')
const currentPreviewReleaseVersion = computed(() => previewStatus.value?.previewReleaseVersion || previewStatus.value?.buildReleaseVersion || '')
const currentStableVersion = computed(() => fmtUnknown(appStore.serverVersion))
const hasLatestRelease = computed(() => !!appStore.latestVersion)
const previewReady = computed(() => previewStatus.value?.status === 'success')
const previewRunning = computed(() => previewStatus.value?.status === 'running')
const previewFailed = computed(() => previewStatus.value?.status === 'failed')
const previewUrl = computed(() => previewStatus.value?.previewUrl || '/preview/')
const previewLogs = computed(() => previewStatus.value?.logTail?.join('\n') || t('settings.dev.noLogs'))
const showPreviewLogs = computed(() => previewRunning.value || previewFailed.value || logsExpanded.value)
const stableBuildCommit = computed(() => fmtUnknown(appStore.buildCommit))
const stableBuildBranch = computed(() => fmtUnknown(appStore.buildBranch))
const stableBuildSource = computed(() => fmtUnknown(appStore.buildSource))
const stableStatusText = computed(() => {
  if (!appStore.connected) return t('updates.sourceUnavailable')
  return 'Running'
})
const stableStatusType = computed(() => (appStore.connected ? 'success' : 'error'))
const stableLastCheckedText = computed(() => fmtTime(stableLastCheckedAt.value))
const latestReleaseLabel = computed(() => {
  if (!hasLatestRelease.value) return t('updates.unavailable')
  return `${latestReleaseVersion.value} available`
})
const updateLiveLabel = computed(() => {
  if (hasLatestRelease.value) return t('updates.updateStableTo', { version: latestReleaseVersion.value })
  return t('updates.updateNow')
})
const previewSummaryText = computed(() => {
  if (!releasePreviewAvailable.value && !branchPreviewAvailable.value && !commitPreviewAvailable.value) return t('updates.previewUnavailable')
  if (!previewStatus.value) return 'idle'
  return previewStatus.value.status || 'idle'
})
const previewTagType = computed(() => {
  if ((!releasePreviewAvailable.value && !branchPreviewAvailable.value && !commitPreviewAvailable.value) || !previewStatus.value) return 'default'
  switch (previewStatus.value.status) {
    case 'running': return 'warning'
    case 'success': return 'success'
    case 'failed': return 'error'
    default: return 'default'
  }
})
const previewSourceOptions = computed<Array<{ label: string, value: PreviewSourceKind, disabled?: boolean }>>(() => {
  const options: Array<{ label: string, value: PreviewSourceKind, disabled?: boolean }> = [{ label: 'Release', value: 'release', disabled: !releasePreviewAvailable.value }]
  if (devModeEnabled.value) {
    options.push(
      { label: 'Branch', value: 'branch', disabled: !branchPreviewAvailable.value },
      { label: 'Commit', value: 'commit', disabled: !commitPreviewAvailable.value },
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
const repositoryResolution = computed(() => previewCapabilities.value?.repository || null)
const repositoryStatusText = computed(() => {
  const resolution = repositoryResolution.value
  if (!resolution) return 'Repository status unknown'
  if (resolution.available && resolution.repoRoot) return `Valid repository: ${resolution.repoRoot}`
  if (resolution.reason === 'repo_path_missing') return 'Repository path is missing or unavailable'
  if (resolution.reason === 'not_git_repo') return 'Repository is not configured or is not a git checkout'
  return 'Repository not available'
})
const repositoryBlocksSelectedDevSource = computed(() => {
  if (previewSourceKind.value === 'release') return false
  const resolution = repositoryResolution.value
  if (!resolution) return true
  return !resolution.available || resolution.reason === 'repo_path_missing' || resolution.reason === 'not_git_repo'
})
const repoTypeOptions = [
  { label: 'Git URL', value: 'git-url' },
  { label: 'GitHub repo', value: 'github' },
  { label: 'Local path', value: 'local' },
]
const canSaveRepository = computed(() => {
  if (repoType.value === 'local') return Boolean(repoLocalPath.value.trim())
  if (repoType.value === 'git-url') return Boolean(repoGitUrl.value.trim())
  return Boolean(parseGithubOwnerRepo(repoGithubOwnerRepo.value))
})
const canBuildPreview = computed(() => {
  if (previewSourceKind.value === 'release') return releasePreviewAvailable.value && Boolean(selectedReleaseVersion.value)
  if (!canUseDevMode.value) return false
  if (!devModeEnabled.value) return false
  if (previewSourceKind.value === 'branch') return branchPreviewAvailable.value && Boolean(previewBranchRef.value)
  return commitPreviewAvailable.value && Boolean(previewCommitRef.value)
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

function fmtUnknown(value: string | null | undefined) {
  return value?.trim() || 'unknown'
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

function parseGithubOwnerRepo(value: string): { owner: string, repo: string } | null {
  const raw = value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  const [owner, repo] = raw.split('/').map(part => part.trim()).filter(Boolean)
  return owner && repo ? { owner, repo } : null
}

function currentRepositoryDescriptor(): PreviewRepositoryDescriptor | null {
  if (repoType.value === 'local') {
    const path = repoLocalPath.value.trim()
    return path ? { type: 'local', path } : null
  }
  if (repoType.value === 'git-url') {
    const url = repoGitUrl.value.trim()
    return url ? { type: 'git-url', url } : null
  }
  const parsed = parseGithubOwnerRepo(repoGithubOwnerRepo.value)
  return parsed ? { type: 'github', ...parsed } : null
}

function syncRepositoryForm() {
  const descriptor = previewCapabilities.value?.repository?.descriptor
  if (!descriptor) return
  repoType.value = descriptor.type
  if (descriptor.type === 'local') repoLocalPath.value = descriptor.path
  if (descriptor.type === 'git-url') repoGitUrl.value = descriptor.url
  if (descriptor.type === 'github') repoGithubOwnerRepo.value = `${descriptor.owner}/${descriptor.repo}`
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
    const [capabilitiesResult, statusResult] = await Promise.allSettled([
      fetchBranchPreviewCapabilities(),
      fetchBranchBuildStatus(),
    ])

    if (capabilitiesResult.status === 'fulfilled') {
      previewCapabilities.value = capabilitiesResult.value
      syncRepositoryForm()
    } else {
      previewCapabilities.value = null
    }

    if (statusResult.status === 'fulfilled') {
      const status = statusResult.value
      previewStatus.value = status
      previewBranchRef.value = status.previewBranch || status.buildBranch || previewBranchRef.value
    } else {
      previewStatus.value = null
    }

    const releaseProvider = previewSourceCapabilities.value.release
    if (releaseProvider.canListTargets && releaseProvider.available) {
      try {
        const releases = await fetchAvailableReleases()
        availableReleases.value = [...releases]
        if (!releaseVersionRef.value || !availableReleases.value.includes(releaseVersionRef.value)) {
          releaseVersionRef.value = availableReleases.value[0] || appStore.latestVersion || ''
        }
      } catch {
        availableReleases.value = appStore.latestVersion ? [appStore.latestVersion] : []
        if (!releaseVersionRef.value) {
          releaseVersionRef.value = appStore.latestVersion || ''
        }
      }
    } else {
      availableReleases.value = appStore.latestVersion ? [appStore.latestVersion] : []
      if (!releaseVersionRef.value) {
        releaseVersionRef.value = appStore.latestVersion || ''
      }
    }

    const branchProvider = previewSourceCapabilities.value.branch
    if (forceDevModeEnabled && branchProvider.canListTargets && branchProvider.available) {
      try {
        const branches = await fetchBranchBuildBranches()
        previewBranches.value = [...branches].sort((a, b) => a.localeCompare(b))
        ensureBranchSelection()
      } catch {
        previewBranches.value = []
      }
    } else {
      previewBranches.value = []
    }

    if (previewSourceKind.value !== 'release' && !previewSourceCapabilities.value[previewSourceKind.value].available) {
      previewSourceKind.value = 'release'
    }
  } catch (err: any) {
    previewCapabilities.value = null
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

async function handleSaveRepository(validate = true) {
  const descriptor = currentRepositoryDescriptor()
  if (!descriptor) {
    message.warning('Enter a repository first')
    return
  }
  repositorySaving.value = true
  try {
    await savePreviewRepository(descriptor, validate)
    message.success(validate ? 'Repository validated' : 'Repository saved')
    await refreshPreviewStatus(true)
  } catch (err: any) {
    message.error(err?.message || 'Failed to save repository')
    await refreshPreviewStatus(true)
  } finally {
    repositorySaving.value = false
  }
}

async function handleFetchBranches() {
  previewLoading.value = true
  try {
    previewBranches.value = await fetchBranchBuildBranches()
    ensureBranchSelection()
    message.success('Branches refreshed')
  } catch (err: any) {
    message.error(err?.message || 'Failed to load branches')
  } finally {
    previewLoading.value = false
  }
}

async function handleBuildPreview() {
  if (!canBuildPreview.value) return

  previewActionLoading.value = true
  try {
    if (previewSourceKind.value === 'release') {
      await restoreLatestUpstreamRelease(selectedReleaseVersion.value || undefined)
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
              <p class="card-copy card-eyebrow">Live app at /</p>
              <div class="metric-row">
                <span>{{ t('updates.installedVersion') }}</span>
                <strong>{{ currentStableVersion }}</strong>
              </div>
              <div class="metric-row">
                <span>{{ t('updates.latestReleaseVersion') }}</span>
                <strong>{{ latestReleaseLabel }}</strong>
              </div>
              <div class="metric-row">
                <span>Build</span>
                <strong>{{ stableBuildCommit }} · {{ stableBuildBranch }}</strong>
              </div>
              <div class="metric-row muted-row">
                <span>Source</span>
                <strong>{{ stableBuildSource }}</strong>
              </div>
              <div class="metric-row muted-row">
                <span>{{ t('updates.lastChecked') }}</span>
                <strong>{{ stableLastCheckedText }}</strong>
              </div>

              <div class="actions-row">
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
                  {{ appStore.updating ? t('updates.updating') : updateLiveLabel }}
                </NButton>
              </div>
            </div>
          </NCard>

          <NCard size="small" class="updates-card" :title="t('updates.previewTitle')">
            <template #header-extra>
              <NTag :type="previewTagType" size="small">
                {{ previewSummaryText }}
              </NTag>
            </template>

            <div class="card-stack">
              <p class="card-copy">Candidate app at /preview/</p>
              <p class="card-copy preview-mode-copy">{{ previewModeCopy }}</p>

              <NAlert v-if="!releasePreviewAvailable && !branchPreviewAvailable && !commitPreviewAvailable" type="info" :title="t('updates.previewUnavailableTitle')">
                {{ t('updates.previewUnavailable') }}
              </NAlert>

              <template v-else>
                <div v-if="canUseDevMode" class="field-row dev-mode-row">
                  <div class="dev-mode-copy">
                    <strong>Developer Mode</strong>
                    <span>{{ devModeEnabled ? 'on' : 'off' }}</span>
                  </div>
                  <NSwitch
                    :value="devModeEnabled"
                    :loading="devModeSaving"
                    :disabled="devModeSaving"
                    @update:value="handleDevModeToggle"
                  />
                </div>
                <p v-if="canUseDevMode" class="muted-note">
                  {{ devModeEnabled ? 'Branch and commit previews from a repository.' : 'Enable branch and commit previews.' }}
                </p>

                <section v-if="canUseDevMode && devModeEnabled" class="developer-panel">
                  <div class="developer-panel-header">
                    <strong>Repository</strong>
                    <span>Branch and commit previews use repository checkout/build scripts.</span>
                  </div>
                  <div class="field-grid">
                    <div class="field-row">
                      <span>Type</span>
                      <NSelect v-model:value="repoType" size="small" :options="repoTypeOptions" :disabled="repositorySaving || previewActionLoading" />
                    </div>
                    <div v-if="repoType === 'git-url'" class="field-row">
                      <span>URL</span>
                      <input v-model="repoGitUrl" class="text-input" type="text" placeholder="https://github.com/owner/repo.git" :disabled="repositorySaving || previewActionLoading">
                    </div>
                    <div v-else-if="repoType === 'github'" class="field-row">
                      <span>URL</span>
                      <input v-model="repoGithubOwnerRepo" class="text-input" type="text" placeholder="owner/repo" :disabled="repositorySaving || previewActionLoading">
                    </div>
                    <div v-else class="field-row">
                      <span>URL</span>
                      <input v-model="repoLocalPath" class="text-input" type="text" placeholder="/path/to/hermes-web-ui" :disabled="repositorySaving || previewActionLoading">
                    </div>
                  </div>
                  <div class="metric-row muted-row">
                    <span>Status</span>
                    <strong>{{ repositoryStatusText }}</strong>
                  </div>
                  <NAlert v-if="repositoryBlocksSelectedDevSource" type="warning" title="Repository required">
                    Configure and validate a local path, Git URL, or GitHub repo to build branch or commit previews.
                  </NAlert>
                  <div class="actions-row">
                    <NButton size="small" type="primary" :disabled="!canSaveRepository" :loading="repositorySaving" @click="handleSaveRepository(true)">
                      Validate
                    </NButton>
                    <NButton size="small" :disabled="!canSaveRepository || repositorySaving" @click="handleSaveRepository(false)">
                      Save only
                    </NButton>
                    <NButton size="small" :disabled="!branchPreviewAvailable || previewLoading" :loading="previewLoading" @click="handleFetchBranches">
                      Fetch branches
                    </NButton>
                  </div>
                </section>

                <div class="section-label">Build preview from</div>
                <div class="field-grid">
                  <div class="field-row">
                    <span>Source</span>
                    <NSelect
                      v-model:value="previewSourceKind"
                      size="small"
                      :options="previewSourceOptions"
                      :disabled="previewActionLoading"
                    />
                  </div>

                  <div v-if="previewSourceKind === 'release'" class="field-row">
                    <span>Release</span>
                    <NSelect
                      v-model:value="releaseVersionRef"
                      filterable
                      clearable
                      size="small"
                      :loading="previewLoading"
                      :options="releaseOptions"
                      :placeholder="latestReleaseVersion"
                      :disabled="previewActionLoading"
                    />
                    <small class="field-hint">Select which upstream release to restore into the preview slot.</small>
                  </div>

                  <div v-else-if="previewSourceKind === 'branch'" class="field-row">
                    <span>Branch</span>
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
                  <span>Source</span>
                  <strong>{{ currentPreviewSourceLabel }}</strong>
                </div>

                <div class="actions-row">
                  <NButton type="info" :loading="previewActionLoading" :disabled="!canBuildPreview" @click="handleBuildPreview">
                    {{ t('settings.dev.buildPreview') }}
                  </NButton>
                  <NButton v-if="previewReady" type="primary" :loading="previewActionLoading" @click="handlePromotePreview">
                    Preview → Live
                  </NButton>
                  <NButton v-if="previewReady" :disabled="!previewUrl" @click="openPreview">
                    Open preview
                  </NButton>
                </div>

                <div class="log-block">
                  <div class="metric-row log-title-row">
                    <span>Build logs</span>
                    <button class="preview-link-button" type="button" @click="logsExpanded = !logsExpanded">
                      {{ showPreviewLogs ? 'Hide logs' : 'Show logs' }}
                    </button>
                  </div>
                  <pre v-if="showPreviewLogs" class="log-tail">{{ previewLogs }}</pre>
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
  padding: 20px 24px 32px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  width: min(100%, 880px);
  margin: 0 auto;
  padding: 20px 24px 0;
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
  grid-template-columns: minmax(0, 1fr);
  width: min(100%, 880px);
  margin: 0 auto;
  gap: 16px;
}

.updates-card {
  height: 100%;
}

.card-stack {
  display: grid;
  gap: 12px;
}


.developer-panel {
  display: grid;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.04);
}

.developer-panel-header {
  display: grid;
  gap: 4px;

  strong {
    color: $text-primary;
  }

  span {
    color: $text-muted;
    font-size: 12px;
  }
}

.card-eyebrow {
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
}

.muted-note {
  margin: 0;
  color: $text-muted;
  font-size: 12px;
  line-height: 1.45;
}

.section-label {
  color: $text-muted;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.dev-mode-copy {
  display: grid;
  gap: 2px;

  strong {
    color: $text-primary;
    font-size: 13px;
  }

  span {
    color: $text-muted;
    font-size: 12px;
  }
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
