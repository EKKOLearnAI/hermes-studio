import { readonly, ref } from 'vue'

export interface PendingRuntimeRestart {
  version: string
  jobId?: string
}

const pendingRuntimeRestart = ref<PendingRuntimeRestart | null>(null)

export function useRuntimeRestartPrompt() {
  function requestRuntimeRestart(version: string, jobId?: string) {
    if (pendingRuntimeRestart.value) return
    pendingRuntimeRestart.value = { version, ...(jobId ? { jobId } : {}) }
  }

  function clearRuntimeRestart() {
    pendingRuntimeRestart.value = null
  }

  return {
    pendingRuntimeRestart: readonly(pendingRuntimeRestart),
    requestRuntimeRestart,
    clearRuntimeRestart,
  }
}
