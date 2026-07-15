import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

import * as api from '@/api/hermes/android-companion'

describe('Android companion client API', () => {
  beforeEach(() => {
    request.mockReset().mockImplementation((path: string) => {
      if (path.endsWith('/pairing/offers')) return Promise.resolve({ offer: { challengeId: 'challenge:one' } })
      if (path.includes('/devices/') && path.endsWith('/revoke')) return Promise.resolve({ device: { id: 'device:one' } })
      const key = ['devices', 'capabilities', 'commands', 'receipts', 'notifications', 'artifacts', 'takeovers']
        .find(value => path.includes(`/${value}`))
      return Promise.resolve(key ? { [key]: [] } : {})
    })
  })

  it('uses bounded filters and encodes all external identities', async () => {
    await api.fetchAndroidOverview()
    await api.fetchAndroidDevices({ limit: 25 })
    await api.fetchAndroidCapabilities('device / one')
    await api.fetchAndroidCommands({ deviceId: 'device:one', workflowId: 'workflow:one', status: 'waiting_user', limit: 20 })
    await api.fetchAndroidReceipts({ status: 'verified', limit: 30 })
    await api.fetchAndroidNotifications({ deviceId: 'device:one', limit: 40 })
    await api.fetchAndroidArtifacts({ workflowId: 'workflow:one', limit: 50 })
    await api.fetchAndroidTakeovers({ workflowId: 'workflow:one', status: 'claimed', limit: 60 })
    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/android-companion/overview',
      '/api/hermes/android-companion/devices?limit=25',
      '/api/hermes/android-companion/capabilities?deviceId=device+%2F+one',
      '/api/hermes/android-companion/commands?deviceId=device%3Aone&workflowId=workflow%3Aone&status=waiting_user&limit=20',
      '/api/hermes/android-companion/receipts?status=verified&limit=30',
      '/api/hermes/android-companion/notifications?deviceId=device%3Aone&limit=40',
      '/api/hermes/android-companion/artifacts?workflowId=workflow%3Aone&limit=50',
      '/api/hermes/android-companion/takeovers?workflowId=workflow%3Aone&status=claimed&limit=60',
    ])
  })

  it('keeps trust mutations exact and never accepts private or session key inputs', async () => {
    await api.issueAndroidPairingOffer()
    await api.revokeAndroidPairingOffer('challenge / one')
    await api.revokeAndroidDevice('device / one', 7, 'DEVICE_REVOKED_BY_ADMIN')
    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/android-companion/pairing/offers',
      '/api/hermes/android-companion/pairing/offers/challenge%20%2F%20one',
      '/api/hermes/android-companion/devices/device%20%2F%20one/revoke',
    ])
    expect(request.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'DELETE', 'POST'])
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ expectedVersion: 7, reason: 'DEVICE_REVOKED_BY_ADMIN' })
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/privateKey|sessionKey|accessToken|executionToken/i)
  })
})
