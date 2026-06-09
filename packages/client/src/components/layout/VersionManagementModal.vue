<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NDrawer, NDrawerContent, NProgress, NSpin, NTag, useMessage } from 'naive-ui'
import {
  activateRuntimeVersion,
  activateWebUiVersion,
  downloadRuntimeVersion,
  downloadWebUiVersion,
  fetchRuntimeVersionStatus,
  fetchVersionDownloadJobs,
  type InstalledRuntimeVersion,
  type InstalledWebUiVersion,
  type RuntimeVersionStatus,
  type VersionDownloadJob,
  type VersionDownloadJobStatus,
  type VersionDownloadKind,
  type VersionDownloadSource,
} from '@/api/hermes/runtime-versions'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (event: 'update:show', value: boolean): void }>()

const { t } = useI18n()
const message = useMessage()

const status = ref<RuntimeVersionStatus | null>(null)
const jobs = ref<VersionDownloadJob[]>([])
const loading = ref(false)
const actionLoading = ref<Record<string, boolean>>({})
const loadError = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

const currentPlatformRuntime = computed(() =>
  (status.value?.hermes.installed || []).filter(item => item.platform === status.value?.platform),
)

const runtimeVersions = computed(() => uniqueVersions([
  ...(status.value?.hermes.remoteVersions || []),
  ...currentPlatformRuntime.value.map(item => item.version),
]))

const webUiVersions = computed(() => uniqueVersions([
  ...(status.value?.webui.remoteVersions || []),
  ...(status.value?.webui.installed || []).map(item => item.version),
  status.value?.webui.currentVersion || '',
]))

watch(() => props.show, show => {
  if (show) {
    void loadAll()
  } else {
    stopPolling()
  }
})

onBeforeUnmount(stopPolling)

function updateShow(show: boolean) {
  emit('update:show', show)
}

function uniqueVersions(values: string[]): string[] {
  return Array.from(new Set(values.map(item => item.trim().replace(/^v/, '')).filter(Boolean)))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
}

async function loadAll() {
  loading.value = true
  loadError.value = ''
  try {
    await Promise.all([loadStatus(), loadJobs()])
    if (hasRunningJobs()) startPolling()
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function loadStatus() {
  status.value = await fetchRuntimeVersionStatus()
}

async function loadJobs() {
  const nextJobs = await fetchVersionDownloadJobs()
  jobs.value = nextJobs.jobs
}

async function refreshJobs() {
  try {
    const hadRunning = hasRunningJobs()
    await loadJobs()
    if (hadRunning && !hasRunningJobs()) {
      stopPolling()
      await loadStatus()
    } else if (!hasRunningJobs()) {
      stopPolling()
    }
  } catch {
    stopPolling()
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void refreshJobs()
  }, 2000)
}

function stopPolling() {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

function hasRunningJobs(): boolean {
  return jobs.value.some(job => job.status === 'queued' || job.status === 'running')
}

function runtimeFor(version: string): InstalledRuntimeVersion | undefined {
  return currentPlatformRuntime.value.find(item => item.version === version)
}

function webUiFor(version: string): InstalledWebUiVersion | undefined {
  return status.value?.webui.installed.find(item => item.version === version)
}

function activeJob(kind: VersionDownloadKind, version: string): VersionDownloadJob | undefined {
  return jobs.value.find(job =>
    job.kind === kind &&
    job.version === version.replace(/^v/, '') &&
    (job.status === 'queued' || job.status === 'running'),
  )
}

function jobType(statusValue: VersionDownloadJobStatus): 'default' | 'info' | 'success' | 'error' | 'warning' {
  if (statusValue === 'completed') return 'success'
  if (statusValue === 'failed') return 'error'
  if (statusValue === 'running') return 'info'
  return 'warning'
}

function jobLabel(job: VersionDownloadJob): string {
  if (job.status === 'completed' || job.status === 'failed') {
    return t(`runtimeVersions.jobStatus.${job.status}`)
  }
  return t(`runtimeVersions.jobStageStatus.${job.stage}`)
}

function messageText(message: string): string {
  return message.startsWith('runtimeVersions.') ? t(message) : message
}

function setActionLoading(key: string, value: boolean) {
  actionLoading.value = { ...actionLoading.value, [key]: value }
}

async function runAction(key: string, action: () => Promise<void>) {
  setActionLoading(key, true)
  try {
    await action()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    setActionLoading(key, false)
  }
}

function sourceLabel(source: VersionDownloadSource): string {
  return source === 'github' ? t('runtimeVersions.github') : t('runtimeVersions.cf')
}

function formatBytes(value?: number): string {
  if (!value || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

function jobProgressText(job: VersionDownloadJob): string {
  if (job.receivedBytes && job.totalBytes) {
    return `${formatBytes(job.receivedBytes)} / ${formatBytes(job.totalBytes)}`
  }
  if (job.receivedBytes) return formatBytes(job.receivedBytes)
  return messageText(job.message)
}

async function startRuntimeDownload(version: string, source: VersionDownloadSource) {
  await runAction(`download-runtime-${source}-${version}`, async () => {
    const response = await downloadRuntimeVersion(version, source)
    jobs.value = [response.job, ...jobs.value.filter(job => job.id !== response.job.id)]
    message.success(t('runtimeVersions.downloadStarted'))
    startPolling()
  })
}

async function startWebUiDownload(version: string, source: VersionDownloadSource) {
  await runAction(`download-webui-${source}-${version}`, async () => {
    const response = await downloadWebUiVersion(version, source)
    jobs.value = [response.job, ...jobs.value.filter(job => job.id !== response.job.id)]
    message.success(t('runtimeVersions.downloadStarted'))
    startPolling()
  })
}

async function useRuntime(version: string) {
  await runAction(`activate-runtime-${version}`, async () => {
    await activateRuntimeVersion(version)
    message.success(t('runtimeVersions.activateSuccess'))
    await loadAll()
  })
}

async function useWebUi(version: string) {
  await runAction(`activate-webui-${version}`, async () => {
    await activateWebUiVersion(version)
    message.success(t('runtimeVersions.activateSuccess'))
    await loadAll()
  })
}
</script>

<template>
  <NDrawer
    :show="props.show"
    placement="right"
    :width="'min(860px, calc(100vw - 24px))'"
    @update:show="updateShow"
  >
    <NDrawerContent :title="t('runtimeVersions.title')" closable>
      <NSpin :show="loading">
        <div class="version-management">
          <NAlert v-if="loadError" type="error" :bordered="false">
            {{ loadError }}
          </NAlert>
          <NAlert v-if="status?.remoteError" type="warning" :bordered="false">
            {{ t('runtimeVersions.remoteLoadFailed') }}: {{ status.remoteError }}
          </NAlert>

        <section class="version-section">
          <div class="section-heading">
            <div>
              <h3>{{ t('runtimeVersions.runtimeTitle') }}</h3>
              <p>{{ t('runtimeVersions.platform') }}: {{ status?.platform || '-' }}</p>
            </div>
            <NButton size="small" secondary @click="loadAll">{{ t('runtimeVersions.refresh') }}</NButton>
          </div>
          <div class="active-path">
            <span>{{ t('runtimeVersions.activeVersion') }}: {{ status?.hermes.activeVersion || '-' }}</span>
            <span :title="status?.hermes.activeDirectory || ''">{{ status?.hermes.activeDirectory || '-' }}</span>
          </div>
          <div class="version-list">
            <div v-for="version in runtimeVersions" :key="`runtime-${version}`" class="version-row">
              <div class="version-main">
                <strong>{{ version }}</strong>
                <NTag v-if="runtimeFor(version)?.active" size="small" type="success" :bordered="false">
                  {{ t('runtimeVersions.active') }}
                </NTag>
                <NTag v-else-if="runtimeFor(version)" size="small" :bordered="false">
                  {{ t('runtimeVersions.installed') }}
                </NTag>
                <NTag v-if="activeJob('runtime', version)" size="small" :type="jobType(activeJob('runtime', version)!.status)" :bordered="false">
                  {{ jobLabel(activeJob('runtime', version)!) }}
                </NTag>
              </div>
              <div class="version-actions">
                <NButton
                  v-if="runtimeFor(version) && !runtimeFor(version)?.active"
                  size="small"
                  secondary
                  :loading="actionLoading[`activate-runtime-${version}`]"
                  @click="useRuntime(version)"
                >
                  {{ t('runtimeVersions.useVersion') }}
                </NButton>
                <NButton
                  v-if="!runtimeFor(version)"
                  size="small"
                  type="primary"
                  secondary
                  :disabled="!!activeJob('runtime', version)"
                  :loading="actionLoading[`download-runtime-github-${version}`]"
                  @click="startRuntimeDownload(version, 'github')"
                >
                  {{ t('runtimeVersions.downloadGithub') }}
                </NButton>
                <NButton
                  v-if="!runtimeFor(version)"
                  size="small"
                  type="primary"
                  secondary
                  :disabled="!!activeJob('runtime', version)"
                  :loading="actionLoading[`download-runtime-cf-${version}`]"
                  @click="startRuntimeDownload(version, 'cf')"
                >
                  {{ t('runtimeVersions.downloadCf') }}
                </NButton>
              </div>
            </div>
            <div v-if="runtimeVersions.length === 0" class="empty-row">{{ t('runtimeVersions.noVersions') }}</div>
          </div>
        </section>

        <section class="version-section">
          <div class="section-heading">
            <div>
              <h3>{{ t('runtimeVersions.webUiTitle') }}</h3>
              <p>{{ t('runtimeVersions.currentWebUi') }}: {{ status?.webui.currentVersion || '-' }}</p>
            </div>
          </div>
          <div class="active-path">
            <span>{{ t('runtimeVersions.activeVersion') }}: {{ status?.webui.activeVersion || '-' }}</span>
            <span :title="status?.webui.activeDirectory || ''">{{ status?.webui.activeDirectory || '-' }}</span>
          </div>
          <div class="version-list">
            <div v-for="version in webUiVersions" :key="`webui-${version}`" class="version-row">
              <div class="version-main">
                <strong>{{ version }}</strong>
                <NTag v-if="webUiFor(version)?.active || version === status?.webui.activeVersion" size="small" type="success" :bordered="false">
                  {{ t('runtimeVersions.active') }}
                </NTag>
                <NTag v-else-if="webUiFor(version)" size="small" :bordered="false">
                  {{ t('runtimeVersions.installed') }}
                </NTag>
                <NTag v-if="activeJob('webui', version)" size="small" :type="jobType(activeJob('webui', version)!.status)" :bordered="false">
                  {{ jobLabel(activeJob('webui', version)!) }}
                </NTag>
              </div>
              <div class="version-actions">
                <NButton
                  v-if="webUiFor(version) && !webUiFor(version)?.active && version !== status?.webui.activeVersion"
                  size="small"
                  secondary
                  :loading="actionLoading[`activate-webui-${version}`]"
                  @click="useWebUi(version)"
                >
                  {{ t('runtimeVersions.useVersion') }}
                </NButton>
                <NButton
                  v-if="!webUiFor(version) && version !== status?.webui.activeVersion"
                  size="small"
                  type="primary"
                  secondary
                  :disabled="!!activeJob('webui', version)"
                  :loading="actionLoading[`download-webui-github-${version}`]"
                  @click="startWebUiDownload(version, 'github')"
                >
                  {{ t('runtimeVersions.downloadGithub') }}
                </NButton>
                <NButton
                  v-if="!webUiFor(version) && version !== status?.webui.activeVersion"
                  size="small"
                  type="primary"
                  secondary
                  :disabled="!!activeJob('webui', version)"
                  :loading="actionLoading[`download-webui-cf-${version}`]"
                  @click="startWebUiDownload(version, 'cf')"
                >
                  {{ t('runtimeVersions.downloadCf') }}
                </NButton>
              </div>
            </div>
            <div v-if="webUiVersions.length === 0" class="empty-row">{{ t('runtimeVersions.noVersions') }}</div>
          </div>
        </section>

        <section class="version-section" v-if="jobs.length > 0">
          <div class="section-heading compact">
            <h3>{{ t('runtimeVersions.downloadTasks') }}</h3>
          </div>
          <div class="job-list">
            <div v-for="job in jobs.slice(0, 6)" :key="job.id" class="job-row">
              <div class="job-main">
                <span>{{ job.kind === 'runtime' ? t('runtimeVersions.runtimeTitle') : t('runtimeVersions.webUiTitle') }} {{ job.version }} · {{ sourceLabel(job.source) }}</span>
                <div v-if="job.status === 'running' || job.status === 'queued'" class="job-progress">
                  <NProgress
                    type="line"
                    :percentage="Math.round(job.percent || 0)"
                    :show-indicator="typeof job.percent === 'number'"
                    :processing="job.status === 'running' && job.stage === 'download'"
                  />
                  <small>{{ jobProgressText(job) }}</small>
                </div>
                <small v-if="job.error">{{ job.error }}</small>
              </div>
              <NTag size="small" :type="jobType(job.status)" :bordered="false">{{ jobLabel(job) }}</NTag>
            </div>
          </div>
        </section>
        </div>
      </NSpin>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.version-management {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.version-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;

  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  p {
    margin: 4px 0 0;
    color: var(--text-color-3);
    font-size: 12px;
  }

  &.compact {
    align-items: center;
  }
}

.active-path {
  display: grid;
  grid-template-columns: minmax(130px, auto) minmax(0, 1fr);
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-color-2);
  font-size: 12px;

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.version-list,
.job-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}

.version-row,
.job-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);

  &:last-child {
    border-bottom: 0;
  }
}

.version-main,
.job-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.job-main {
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;

  small {
    color: var(--text-color-3);
    word-break: break-word;
  }

  > small {
    color: var(--error-color);
  }
}

.job-progress {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(120px, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.version-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
  gap: 8px;
}

.empty-row {
  padding: 14px 10px;
  color: var(--text-color-3);
  font-size: 13px;
  text-align: center;
}

@media (max-width: 640px) {
  .section-heading,
  .version-row,
  .job-row {
    align-items: stretch;
    flex-direction: column;
  }

  .active-path {
    grid-template-columns: 1fr;
    gap: 4px;
  }

  .version-actions {
    justify-content: flex-start;
  }
}
</style>
