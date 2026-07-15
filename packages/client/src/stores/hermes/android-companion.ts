import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/api/hermes/android-companion'
import type {
  AndroidArtifactDto, AndroidCommandDto, AndroidNotificationDto, AndroidOverviewDto,
  AndroidPairingOfferDto, AndroidReceiptDto, AndroidTakeoverDto,
} from '@/api/hermes/android-companion'

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export const useAndroidCompanionStore = defineStore('android-companion', () => {
  const overview = ref<AndroidOverviewDto | null>(null)
  const commands = ref<AndroidCommandDto[]>([])
  const receipts = ref<AndroidReceiptDto[]>([])
  const notifications = ref<AndroidNotificationDto[]>([])
  const artifacts = ref<AndroidArtifactDto[]>([])
  const takeovers = ref<AndroidTakeoverDto[]>([])
  const pairingOffer = ref<AndroidPairingOfferDto | null>(null)
  const loading = ref(false)
  const activeSaves = ref(0)
  const saving = computed(() => activeSaves.value > 0)
  const error = ref<string | null>(null)
  const activeTakeovers = computed(() => takeovers.value.filter(item => ['requested', 'claimed'].includes(item.status)))
  const activeCommands = computed(() => commands.value.filter(item =>
    !['succeeded', 'failed', 'cancelled'].includes(item.status)))

  let generation = 0
  let loadSequence = 0
  const queues = new Map<string, Promise<unknown>>()

  async function loadDashboard() {
    const operation = { generation, sequence: ++loadSequence }
    loading.value = true
    error.value = null
    try {
      const [nextOverview, nextCommands, nextReceipts, nextNotifications, nextArtifacts, nextTakeovers]
        = await Promise.all([
          api.fetchAndroidOverview(), api.fetchAndroidCommands({ limit: 100 }),
          api.fetchAndroidReceipts({ limit: 100 }), api.fetchAndroidNotifications({ limit: 100 }),
          api.fetchAndroidArtifacts({ limit: 100 }), api.fetchAndroidTakeovers({ limit: 100 }),
        ])
      if (operation.generation === generation && operation.sequence === loadSequence) {
        overview.value = nextOverview
        commands.value = nextCommands.slice()
        receipts.value = nextReceipts.slice()
        notifications.value = nextNotifications.slice()
        artifacts.value = nextArtifacts.slice()
        takeovers.value = nextTakeovers.slice()
      }
      return nextOverview
    } catch (cause) {
      if (operation.generation === generation && operation.sequence === loadSequence) error.value = errorMessage(cause)
      throw cause
    } finally {
      if (operation.generation === generation && operation.sequence === loadSequence) loading.value = false
    }
  }

  function mutate<T>(key: string, operation: () => Promise<T>, accept?: (value: T) => void): Promise<T> {
    const callGeneration = generation
    activeSaves.value += 1
    error.value = null
    const run = async () => {
      try {
        const value = await operation()
        if (callGeneration === generation) accept?.(value)
        return value
      } catch (cause) {
        if (callGeneration === generation) error.value = errorMessage(cause)
        throw cause
      } finally {
        if (callGeneration === generation) activeSaves.value = Math.max(0, activeSaves.value - 1)
      }
    }
    const prior = queues.get(key)
    const task = prior ? prior.catch(() => undefined).then(run) : run()
    queues.set(key, task)
    void task.finally(() => { if (queues.get(key) === task) queues.delete(key) }).catch(() => undefined)
    return task
  }

  function issuePairingOffer() {
    return mutate('pairing', api.issueAndroidPairingOffer, value => { pairingOffer.value = value })
  }
  function revokePairingOffer(challengeId: string) {
    return mutate('pairing', () => api.revokeAndroidPairingOffer(challengeId), value => {
      if (value.challengeId === pairingOffer.value?.challengeId) pairingOffer.value = null
    })
  }
  function revokeDevice(deviceId: string, expectedVersion: number) {
    return mutate(`device:${deviceId}`, async () => {
      const device = await api.revokeAndroidDevice(deviceId, expectedVersion, 'DEVICE_REVOKED_BY_ADMIN')
      await loadDashboard()
      return device
    })
  }
  function clearPairingOffer() { pairingOffer.value = null }
  function reset() {
    generation += 1; loadSequence += 1
    overview.value = null; commands.value = []; receipts.value = []; notifications.value = []
    artifacts.value = []; takeovers.value = []; pairingOffer.value = null
    loading.value = false; activeSaves.value = 0; error.value = null; queues.clear()
  }
  onScopeDispose(() => { generation += 1; loadSequence += 1; queues.clear() })

  return {
    overview, commands, receipts, notifications, artifacts, takeovers, pairingOffer,
    activeTakeovers, activeCommands, loading, saving, error,
    loadDashboard, issuePairingOffer, revokePairingOffer, revokeDevice, clearPairingOffer, $reset: reset,
  }
})
