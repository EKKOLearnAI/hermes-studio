import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ request }))

describe('App Relay API', () => {
  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue({
      relay: {
        connected: true,
        machineId: 'hwui_machine',
        pairingCode: 'ABCD2345',
        pairingExpiresAt: 12345,
      },
      appAuth: {
        baseUrl: 'http://127.0.0.1:8077',
      },
    })
  })

  it('uses the independent App Relay management endpoints', async () => {
    const api = await import('@/api/hermes/app-relay')

    await api.fetchAppRelayStatus()
    await api.connectAppRelay()
    await api.refreshAppRelayPairingCode()
    await api.disconnectAppRelay()

    expect(request.mock.calls).toEqual([
      ['/api/app-relay/status'],
      ['/api/app-relay/connect', { method: 'POST' }],
      ['/api/app-relay/pairing-code', { method: 'POST' }],
      ['/api/app-relay/disconnect', { method: 'POST' }],
    ])
  })

  it('returns the fixed account-service bootstrap URL from the local server', async () => {
    const { fetchAppRelayBootstrap } = await import('@/api/hermes/app-relay')

    await expect(fetchAppRelayBootstrap()).resolves.toMatchObject({
      appAuthBaseUrl: 'http://127.0.0.1:8077',
      relay: { machineId: 'hwui_machine' },
    })
  })
})
