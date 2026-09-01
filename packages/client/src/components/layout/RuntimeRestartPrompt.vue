<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NCard, NModal, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchVersionDownloadJobs,
  restartWebUiAfterRuntimeChange,
} from '@/api/hermes/runtime-versions'
import { useRuntimeRestartPrompt } from '@/composables/useRuntimeRestartPrompt'
import { desktopBridge } from '@/utils/desktop-bridge'

const POLL_INTERVAL_MS = 2000
const HANDLED_JOBS_KEY = 'hermes-runtime-restart-handled-jobs'

const { t } = useI18n()
const message = useMessage()
const {
  pendingRuntimeRestart,
  requestRuntimeRestart,
  clearRuntimeRestart,
} = useRuntimeRestartPrompt()
const restarting = ref(false)
const handledJobIds = new Set<string>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let restartWaitTimer: ReturnType<typeof setInterval> | null = null

function restoreHandledJobs() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(HANDLED_JOBS_KEY) || '[]')
    if (Array.isArray(stored)) {
      for (const id of stored) if (typeof id === 'string') handledJobIds.add(id)
    }
  } catch {
    // Ignore malformed or unavailable session storage.
  }
}

function rememberHandledJob(jobId?: string) {
  if (!jobId) return
  handledJobIds.add(jobId)
  try {
    sessionStorage.setItem(HANDLED_JOBS_KEY, JSON.stringify([...handledJobIds]))
  } catch {
    // The in-memory marker still prevents duplicate prompts in this page.
  }
}

async function checkCompletedRuntimeDownloads() {
  try {
    const response = await fetchVersionDownloadJobs()
    const completed = response.jobs.filter(job =>
      job.kind === 'runtime'
      && job.status === 'completed'
      && !handledJobIds.has(job.id),
    )
    if (completed.length === 0) return
    if (pendingRuntimeRestart.value) {
      for (const job of completed) rememberHandledJob(job.id)
      return
    }
    for (const job of completed.slice(1)) rememberHandledJob(job.id)
    requestRuntimeRestart(completed[0].version, completed[0].id)
  } catch {
    // Authentication and transient network failures are retried by the poller.
  }
}

function restartStandaloneWebUi() {
  let attempts = 0
  let sawUnavailable = false
  restartWaitTimer = setInterval(async () => {
    attempts += 1
    try {
      const response = await fetch('/health', { cache: 'no-store' })
      if (response.ok && (sawUnavailable || attempts >= 15)) {
        if (restartWaitTimer) clearInterval(restartWaitTimer)
        restartWaitTimer = null
        window.location.reload()
      }
    } catch {
      sawUnavailable = true
    }
    if (attempts >= 60) {
      if (restartWaitTimer) clearInterval(restartWaitTimer)
      restartWaitTimer = null
      window.location.reload()
    }
  }, 1000)
}

async function restartNow() {
  if (!pendingRuntimeRestart.value || restarting.value) return
  restarting.value = true
  try {
    const bridge = desktopBridge()
    if (bridge?.isDesktop === true) {
      if (!bridge.restartApp) throw new Error('Desktop restart is unavailable')
      await bridge.restartApp()
    } else {
      await restartWebUiAfterRuntimeChange()
      restartStandaloneWebUi()
    }
    rememberHandledJob(pendingRuntimeRestart.value.jobId)
  } catch (err) {
    restarting.value = false
    message.error(`${t('runtimeVersions.restartFailed')}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function restartLater() {
  rememberHandledJob(pendingRuntimeRestart.value?.jobId)
  clearRuntimeRestart()
}

onMounted(() => {
  restoreHandledJobs()
  void checkCompletedRuntimeDownloads()
  pollTimer = setInterval(() => {
    void checkCompletedRuntimeDownloads()
  }, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (restartWaitTimer) clearInterval(restartWaitTimer)
})
</script>

<template>
  <NModal
    :show="!!pendingRuntimeRestart"
    :mask-closable="false"
    :close-on-esc="false"
  >
    <NCard
      data-testid="runtime-restart-prompt"
      role="dialog"
      :title="t('runtimeVersions.restartPromptTitle')"
      :bordered="false"
      style="width: min(460px, calc(100vw - 32px))"
    >
      <p>
        {{ t('runtimeVersions.restartPromptContent', { version: pendingRuntimeRestart?.version || '-' }) }}
      </p>
      <template #footer>
        <div class="actions">
          <NButton
            data-testid="runtime-restart-later"
            :disabled="restarting"
            @click="restartLater"
          >
            {{ t('runtimeVersions.restartLater') }}
          </NButton>
          <NButton
            data-testid="runtime-restart-now"
            type="primary"
            :loading="restarting"
            @click="restartNow"
          >
            {{ t('runtimeVersions.restartNow') }}
          </NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped lang="scss">
p {
  margin: 0;
  line-height: 1.6;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
