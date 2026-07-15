// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  fetchAndroidOverview: vi.fn(), fetchAndroidCommands: vi.fn(), fetchAndroidReceipts: vi.fn(),
  fetchAndroidNotifications: vi.fn(), fetchAndroidArtifacts: vi.fn(), fetchAndroidTakeovers: vi.fn(),
  issueAndroidPairingOffer: vi.fn(), revokeAndroidPairingOffer: vi.fn(), revokeAndroidDevice: vi.fn(),
}))
vi.mock('@/api/hermes/android-companion', () => api)

import { useAndroidCompanionStore } from '@/stores/hermes/android-companion'

const device = { id: 'device:one', label: 'Pixel', androidVersion: '16', appVersion: '1.0.0', state: 'paired',
  connected: true, signingFingerprint: 'a'.repeat(64), exchangeFingerprint: 'b'.repeat(64), capabilitiesRevision: 1,
  version: 2, pairedAt: 'now', revokedAt: null, revocationReason: null, lastSeenAt: 'now', updatedAt: 'now' }
const overview = { devices: [device], capabilities: [], summary: { pairedDeviceCount: 1, connectedDeviceCount: 1,
  healthyCapabilityCount: 0, activeCommandCount: 1, verifiedReceiptCount: 0, notificationCount: 0,
  artifactCount: 0, pendingTakeoverCount: 1 }, emergencyStop: { level: 0, version: 1 } }
const takeover = { id: 'takeover:one', workflowId: 'workflow:one', commandId: 'command:one', deviceId: 'device:one',
  capabilityId: 'android.app.launch', reasonCode: 'ANDROID_USER_ACTION_REQUIRED', generation: 1, status: 'requested',
  version: 1, requestedAt: 'now', claimedAt: null, completedAt: null, expiresAt: 'later', updatedAt: 'now' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('Android companion store', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); vi.clearAllMocks()
    api.fetchAndroidOverview.mockResolvedValue(overview); api.fetchAndroidCommands.mockResolvedValue([{ id: 'command:one', status: 'waiting_user' }])
    api.fetchAndroidReceipts.mockResolvedValue([]); api.fetchAndroidNotifications.mockResolvedValue([])
    api.fetchAndroidArtifacts.mockResolvedValue([]); api.fetchAndroidTakeovers.mockResolvedValue([takeover])
    api.issueAndroidPairingOffer.mockResolvedValue({ challengeId: 'challenge:one', code: '384921', expiresAt: 'later' })
    api.revokeAndroidPairingOffer.mockResolvedValue({ challengeId: 'challenge:one', revoked: true })
    api.revokeAndroidDevice.mockResolvedValue({ ...device, state: 'revoked', version: 3 })
  })

  it('loads the bounded dashboard and derives active work', async () => {
    const store = useAndroidCompanionStore()
    await store.loadDashboard()
    expect(store.overview).toEqual(overview)
    expect(store.activeCommands).toHaveLength(1)
    expect(store.activeTakeovers).toEqual([takeover])
    expect(api.fetchAndroidCommands).toHaveBeenCalledWith({ limit: 100 })
  })

  it('keeps only the newest dashboard response', async () => {
    const stale = deferred<any>()
    api.fetchAndroidOverview.mockImplementationOnce(() => stale.promise).mockResolvedValueOnce({ ...overview, devices: [] })
    const store = useAndroidCompanionStore()
    const first = store.loadDashboard()
    await store.loadDashboard()
    stale.resolve(overview)
    await first
    expect(store.overview?.devices).toEqual([])
  })

  it('holds a one-time pairing code only in memory and clears it on revocation', async () => {
    const store = useAndroidCompanionStore()
    await store.issuePairingOffer()
    expect(store.pairingOffer?.code).toBe('384921')
    await store.revokePairingOffer('challenge:one')
    expect(store.pairingOffer).toBeNull()
    expect(JSON.stringify(store.$state)).not.toMatch(/privateKey|sessionKey|executionToken|materialDigest/i)
  })

  it('revokes by optimistic version and refreshes authoritative state', async () => {
    const store = useAndroidCompanionStore()
    await store.revokeDevice('device:one', 2)
    expect(api.revokeAndroidDevice).toHaveBeenCalledWith('device:one', 2, 'DEVICE_REVOKED_BY_ADMIN')
    expect(api.fetchAndroidOverview).toHaveBeenCalledTimes(1)
  })
})
