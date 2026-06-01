import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  getAuroraAppWindowMeta,
  type AuroraAppKind,
  type AuroraAppWindow,
} from '@/services/hermes/aurora/capability-manifest'
import { useAppStore } from '@/stores/hermes/app'
import { useMemoryQueueStore } from '@/stores/hermes/memory-queue'
import { useAuroraWorkingMemoryStore } from '@/stores/hermes/working-memory'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'

export type { AuroraAppKind, AuroraAppWindow }
export type AuroraAppWindowPayload = Record<string, unknown> | null

export const useAuroraAppWindowStore = defineStore('aurora-app-window', () => {
  const activeApp = ref<AuroraAppWindow | null>(null)
  const activePayload = ref<AuroraAppWindowPayload>(null)
  const isOpen = computed(() => activeApp.value !== null)

  function openApp(kind: AuroraAppKind, payload: AuroraAppWindowPayload = null) {
    const appStore = useAppStore()
    const activeMeta = getAuroraAppWindowMeta(kind)
    appStore.setAdvancedConsoleOpen(false)
    appStore.setAuroraStatusOpen(false)
    useMemoryQueueStore().closeReviewQueue()
    activeApp.value = activeMeta
    activePayload.value = payload
    useAuroraWorkingMemoryStore().focusApp({
      kind,
      title: activeMeta.title,
      subtitle: activeMeta.subtitle,
      payload,
    })
    auroraEventBus.publish('APP_OPENED', {
      kind,
      title: activeMeta.title,
      source: 'aurora-app-window',
      payload,
    })
  }

  function closeApp() {
    const app = activeApp.value
    const payload = activePayload.value
    activeApp.value = null
    activePayload.value = null
    useAppStore().setAdvancedConsoleOpen(false)
    if (app) {
      useAuroraWorkingMemoryStore().clearFocusedApp(app.kind)
      auroraEventBus.publish('APP_CLOSED', {
        kind: app.kind,
        title: app.title,
        source: 'aurora-app-window',
        payload,
      })
    }
  }

  return {
    activeApp,
    activePayload,
    isOpen,
    openApp,
    closeApp,
  }
})
