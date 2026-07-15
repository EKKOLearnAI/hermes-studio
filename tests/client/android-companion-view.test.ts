// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'

const api = vi.hoisted(() => ({
  fetchAndroidOverview: vi.fn(), fetchAndroidCommands: vi.fn(), fetchAndroidReceipts: vi.fn(),
  fetchAndroidNotifications: vi.fn(), fetchAndroidArtifacts: vi.fn(), fetchAndroidTakeovers: vi.fn(),
  issueAndroidPairingOffer: vi.fn(), revokeAndroidPairingOffer: vi.fn(), revokeAndroidDevice: vi.fn(),
}))
const isStoredSuperAdmin = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/api/hermes/android-companion', () => api)
vi.mock('@/api/client', () => ({ isStoredSuperAdmin }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  NSpin: defineComponent({ props: { show: Boolean }, template: '<div><slot /></div>' }),
}))

import AndroidCompanionView from '@/views/hermes/AndroidCompanionView.vue'

const device = { id: 'device:one', label: 'Pixel 10', androidVersion: '16', appVersion: '1.0.0', state: 'paired',
  connected: true, signingFingerprint: 'a'.repeat(64), exchangeFingerprint: 'b'.repeat(64), capabilitiesRevision: 1,
  version: 2, pairedAt: '2026-07-15T00:00:00Z', revokedAt: null, revocationReason: null,
  lastSeenAt: '2026-07-15T00:01:00Z', updatedAt: '2026-07-15T00:01:00Z' }
const capability = { deviceId: device.id, capabilityId: 'android.app.launch', capabilityVersion: 1,
  packageBinding: 'ai.hermes.companion', packageFingerprint: 'c'.repeat(64), driverVersion: '1.0.0',
  permissions: ['android.permission.PACKAGE_USAGE_STATS'], verificationStrategy: 'fresh_foreground_package_and_signature',
  health: 'healthy', enabled: true, reportRevision: 1, updatedAt: '2026-07-15T00:01:00Z' }
const overview = { devices: [device], capabilities: [capability], summary: { pairedDeviceCount: 1,
  connectedDeviceCount: 1, healthyCapabilityCount: 1, activeCommandCount: 1, verifiedReceiptCount: 1,
  notificationCount: 1, artifactCount: 1, pendingTakeoverCount: 1 }, emergencyStop: { level: 0, version: 1 } }
const takeover = { id: 'takeover:one', workflowId: 'workflow:one', commandId: 'command:one', deviceId: device.id,
  capabilityId: 'android.app.launch', reasonCode: 'ANDROID_USER_ACTION_REQUIRED', generation: 1, status: 'requested',
  version: 1, requestedAt: '2026-07-15T00:00:00Z', claimedAt: null, completedAt: null,
  expiresAt: '2026-07-15T00:10:00Z', updatedAt: '2026-07-15T00:00:00Z' }

describe('AndroidCompanionView', () => {
  beforeEach(() => {
    vi.clearAllMocks(); isStoredSuperAdmin.mockReturnValue(true)
    api.fetchAndroidOverview.mockResolvedValue(overview)
    api.fetchAndroidCommands.mockResolvedValue([{ id: 'command:one', workflowId: 'workflow:one', deviceId: device.id,
      capabilityId: 'android.app.launch', status: 'waiting_user', deliveryAttempts: 1 }])
    api.fetchAndroidReceipts.mockResolvedValue([{ workflowId: 'workflow:one', capabilityId: 'android.app.launch',
      status: 'verified', updatedAt: '2026-07-15T00:01:00Z' }])
    api.fetchAndroidNotifications.mockResolvedValue([{ id: 'notification:one', deviceId: device.id,
      packageBinding: 'ai.hermes.companion', category: 'service', titleSummary: 'Companion ready', textSummary: '',
      sensitivity: 'standard', postedAt: '2026-07-15T00:01:00Z', removedAt: null, updatedAt: '2026-07-15T00:01:00Z' }])
    api.fetchAndroidArtifacts.mockResolvedValue([{ id: 'artifact:one', deviceId: device.id, workflowId: 'workflow:one',
      commandId: 'command:one', digest: 'd'.repeat(64), mimeType: 'image/png', width: 1080, height: 2400,
      byteSize: 1024, capturedAt: '2026-07-15T00:01:00Z', createdAt: '2026-07-15T00:01:00Z' }])
    api.fetchAndroidTakeovers.mockResolvedValue([takeover])
    api.issueAndroidPairingOffer.mockResolvedValue({ challengeId: 'challenge:one', nonce: 'nonce', code: '384921',
      studioDeviceId: 'studio:one', expiresAt: '2026-07-15T00:05:00Z', studio: { deviceId: 'studio:one' } })
    api.revokeAndroidPairingOffer.mockResolvedValue({ challengeId: 'challenge:one', revoked: true })
    api.revokeAndroidDevice.mockResolvedValue({ ...device, state: 'revoked', version: 3 })
  })

  it('renders encrypted device health, minimized activity, and a device-bound takeover', async () => {
    const wrapper = mount(AndroidCompanionView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.find('[data-test="android-status-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Pixel 10')
    expect(wrapper.text()).toContain('android.permission.PACKAGE_USAGE_STATS')
    expect(wrapper.find('[data-test="android-active-takeover"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Companion ready')
    expect(wrapper.html()).not.toMatch(/privateKey|sessionKey|executionToken|notificationKeyHash|encryptionContext/i)
    wrapper.unmount()
  })

  it('creates a short-lived pairing code without persisting companion secrets', async () => {
    const wrapper = mount(AndroidCompanionView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    await wrapper.find('[data-test="android-pairing-issue"]').trigger('click')
    await flushPromises()
    expect(api.issueAndroidPairingOffer).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="android-pairing-code"]').text()).toBe('384921')
    await wrapper.find('[data-test="android-pairing-revoke"]').trigger('click')
    await flushPromises()
    expect(api.revokeAndroidPairingOffer).toHaveBeenCalledWith('challenge:one')
    expect(wrapper.find('[data-test="android-pairing-offer"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('requires explicit confirmation before optimistic-version device revocation', async () => {
    const wrapper = mount(AndroidCompanionView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    await wrapper.find('[data-test="android-device-revoke-device:one"]').trigger('click')
    expect(wrapper.find('[data-test="android-revoke-confirmation"]').exists()).toBe(true)
    expect(api.revokeAndroidDevice).not.toHaveBeenCalled()
    await wrapper.find('[data-test="android-revoke-confirm"]').trigger('click')
    await flushPromises()
    expect(api.revokeAndroidDevice).toHaveBeenCalledWith('device:one', 2, 'DEVICE_REVOKED_BY_ADMIN')
    wrapper.unmount()
  })

  it('disables all trust mutations for read-only users', async () => {
    isStoredSuperAdmin.mockReturnValue(false)
    const wrapper = mount(AndroidCompanionView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.find<HTMLButtonElement>('[data-test="android-pairing-issue"]').element.disabled).toBe(true)
    expect(wrapper.find<HTMLButtonElement>('[data-test="android-device-revoke-device:one"]').element.disabled).toBe(true)
    expect(wrapper.text()).toContain('androidCompanion.readOnly')
    wrapper.unmount()
  })
})
