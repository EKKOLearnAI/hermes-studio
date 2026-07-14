import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

import * as api from '@/api/hermes/home'

describe('home client API', () => {
  beforeEach(() => request.mockReset())

  it('loads normalized dashboard resources with bounded encoded filters', async () => {
    request.mockResolvedValueOnce({ provider: {}, summary: {} })
      .mockResolvedValueOnce({ spaces: [] })
      .mockResolvedValueOnce({ devices: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ bindings: [] })
      .mockResolvedValueOnce({ provider: { connectionStatus: 'connected' } })
    await api.fetchHomeOverview()
    await api.fetchHomeSpaces({ parentSpaceId: 'space:one', kind: 'room', limit: 20 })
    await api.fetchHomeDevices({ spaceId: 'space:one', deviceClass: 'light', limit: 30 })
    await api.fetchHomeInventory({ lowStockOnly: true, limit: 40 })
    await api.fetchHomeBindings({ deviceId: 'device:one', provider: 'home-assistant', limit: 50 })
    await api.fetchHomeProvider()
    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/home/overview',
      '/api/hermes/home/spaces?parentSpaceId=space%3Aone&kind=room&limit=20',
      '/api/hermes/home/devices?spaceId=space%3Aone&deviceClass=light&limit=30',
      '/api/hermes/home/inventory?lowStockOnly=true&limit=40',
      '/api/hermes/home/bindings?deviceId=device%3Aone&provider=home-assistant&limit=50',
      '/api/hermes/home/provider',
    ])
  })

  it('uses only semantic command payloads and encodes every path identity', async () => {
    request.mockResolvedValue({ workflow: { id: 'workflow:one' } })
    await api.refreshHomeDevice('device / one', { bindingId: 'binding:one', externalId: 'light.office',
      requestedAt: '2026-07-15T02:00:00Z', idempotencyKey: 'refresh-1' })
    await api.commandHomeDevice('device / one', { command: 'set_level', bindingId: 'binding:one',
      externalId: 'light.office', expectedStateVersion: 3, verificationTimeoutMs: 30_000,
      desiredLevel: 45, idempotencyKey: 'command-1' })
    await api.activateHomeScene('scene / one', { bindingId: 'binding:scene', externalId: 'scene.evening',
      verificationTimeoutMs: 30_000, idempotencyKey: 'scene-1' })
    await api.fetchHomeWorkflow('workflow / one')
    await api.reviewHomeWorkflow('workflow / one', { action: 'reject', reason: 'Not now' })

    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/home/devices/device%20%2F%20one/refresh',
      '/api/hermes/home/devices/device%20%2F%20one/commands',
      '/api/hermes/home/scenes/scene%20%2F%20one/activate',
      '/api/hermes/home/workflows/workflow%20%2F%20one',
      '/api/hermes/home/workflows/workflow%20%2F%20one/review',
    ])
    const commandBody = JSON.parse(request.mock.calls[1][1].body)
    expect(commandBody).toEqual({ command: 'set_level', bindingId: 'binding:one', externalId: 'light.office',
      expectedStateVersion: 3, verificationTimeoutMs: 30_000, desiredLevel: 45, idempotencyKey: 'command-1' })
    expect(JSON.stringify(commandBody)).not.toMatch(/service|token|credential/i)
  })

  it('sends exact inventory and space writes without retaining caller data', async () => {
    request.mockResolvedValueOnce({ space: { id: 'space:office' } })
      .mockResolvedValueOnce({ item: { id: 'inventory:filters' } })
      .mockResolvedValueOnce({ disposition: 'applied', item: {}, entry: {} })
    await api.upsertHomeSpace({ id: 'space:office', kind: 'room', name: 'Office', expectedVersion: 0 })
    await api.upsertHomeInventoryItem('inventory / filters', { name: 'Filters', unit: 'piece', expectedVersion: 0 })
    await api.adjustHomeInventory('inventory / filters', { delta: -1, reason: 'Installed',
      occurredAt: '2026-07-15T02:00:00Z', idempotencyKey: 'adjust-1' })
    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/home/spaces', '/api/hermes/home/inventory/inventory%20%2F%20filters',
      '/api/hermes/home/inventory/inventory%20%2F%20filters/adjust',
    ])
    expect(request.mock.calls.map(call => call[1].method)).toEqual(['POST', 'PUT', 'POST'])
  })
})
