import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ request }))

describe('App connections API', () => {
  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue({})
  })

  it('uses the connection-specific authorization endpoints', async () => {
    const api = await import('@/api/hermes/app-connections')

    await api.fetchAppConnections()
    await api.createLanAppAuthorization()
    await api.createCloudAppAuthorization(true)
    await api.deleteAppConnection(12)

    expect(request.mock.calls).toEqual([
      ['/api/app-connections'],
      ['/api/app-connections/authorization-codes/lan', { method: 'POST' }],
      ['/api/app-connections/authorization-codes/cloud', { method: 'POST', body: JSON.stringify({ refresh: true }) }],
      ['/api/app-connections/12', { method: 'DELETE' }],
    ])
  })
})
