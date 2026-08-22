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
    })
  })

  it('uses the independent App Relay management endpoints', async () => {
    const api = await import('@/api/hermes/app-relay')

    await api.fetchAppRelayStatus()
    await api.connectAppRelay()
    await api.updateAppRelayRoute('cloudflare')
    await api.refreshAppRelayPairingCode()
    await api.disconnectAppRelay()

    expect(request.mock.calls).toEqual([
      ['/api/app-relay/status'],
      ['/api/app-relay/connect', { method: 'POST' }],
      ['/api/app-relay/route', { method: 'PUT', body: JSON.stringify({ route: 'cloudflare' }) }],
      ['/api/app-relay/pairing-code', { method: 'POST' }],
      ['/api/app-relay/disconnect', { method: 'POST' }],
    ])
  })

})
