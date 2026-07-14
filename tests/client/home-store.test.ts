// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  fetchHomeOverview: vi.fn(), fetchHomeProvider: vi.fn(), fetchHomeSpaces: vi.fn(), fetchHomeDevices: vi.fn(),
  fetchHomeInventory: vi.fn(), fetchHomeWorkflow: vi.fn(), upsertHomeSpace: vi.fn(),
  upsertHomeInventoryItem: vi.fn(), adjustHomeInventory: vi.fn(), refreshHomeDevice: vi.fn(),
  commandHomeDevice: vi.fn(), activateHomeScene: vi.fn(), reviewHomeWorkflow: vi.fn(),
}))
vi.mock('@/api/hermes/home', () => api)

import { useHomeStore } from '@/stores/hermes/home'

const provider = { provider: 'home-assistant', profile: 'default', active: true, configured: true,
  connectionStatus: 'connected', executorEnabled: true, authorizedTargetCount: 1, lastErrorCode: null }
const overview = { provider, summary: { spaceCount: 1, deviceCount: 1, unavailableDeviceCount: 0,
  inventoryItemCount: 1, lowStockItemCount: 1, activeWorkflowCount: 0 } }
const device = { id: 'device:lamp', name: 'Lamp', deviceClass: 'light', availability: 'available',
  bindings: [], states: [], attributes: {}, spaceId: null, version: 1, createdAt: 'now', updatedAt: 'now' }
const item = { id: 'inventory:filter', name: 'Filter', unit: 'piece', quantity: 1, lowStockThreshold: 1,
  attributes: {}, version: 1, createdAt: 'now', updatedAt: 'now' }
const workflow = { id: 'workflow:one', state: 'waiting_user', version: 1, attempt: 0, lastErrorCode: null,
  availableActions: { approve: true, reject: true, cancel: false, retry: false, compensate: false },
  createdAt: 'now', updatedAt: 'now', completedAt: null }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('home store', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); vi.clearAllMocks()
    api.fetchHomeOverview.mockResolvedValue(overview); api.fetchHomeProvider.mockResolvedValue(provider)
    api.fetchHomeSpaces.mockResolvedValue([]); api.fetchHomeDevices.mockResolvedValue([device])
    api.fetchHomeInventory.mockResolvedValue([item]); api.fetchHomeWorkflow.mockResolvedValue({ ...workflow, steps: [] })
  })

  it('loads the whole command center and derives unavailable and low-stock state', async () => {
    const store = useHomeStore()
    await store.loadDashboard()
    expect(store.overview).toEqual(overview)
    expect(store.provider).toEqual(provider)
    expect(store.devices).toEqual([device])
    expect(store.lowStockItems).toEqual([item])
    expect(store.unavailableDevices).toEqual([])
    expect(api.fetchHomeSpaces).toHaveBeenCalledWith({ limit: 200 })
  })

  it('keeps only the newest resource response and failure', async () => {
    const stale = deferred<any[]>()
    api.fetchHomeDevices.mockImplementationOnce(() => stale.promise).mockResolvedValueOnce([{ ...device, id: 'device:new' }])
    const store = useHomeStore()
    const first = store.loadDevices()
    await store.loadDevices()
    stale.reject(new Error('stale provider failure'))
    await expect(first).rejects.toThrow('stale provider failure')
    expect(store.devices[0].id).toBe('device:new')
    expect(store.resourceErrors.devices).toBeNull()
  })

  it('serializes commands for one device while independent devices can proceed', async () => {
    const pending = deferred<any>()
    api.commandHomeDevice.mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ intent: {}, policyDecision: {}, workflow: { ...workflow, id: 'workflow:two' } })
    api.refreshHomeDevice.mockResolvedValue({ intent: {}, policyDecision: {}, workflow: { ...workflow, id: 'workflow:refresh' } })
    const store = useHomeStore()
    const input = { command: 'set_power', bindingId: 'binding:lamp', externalId: 'light.office',
      expectedStateVersion: 1, verificationTimeoutMs: 30_000, desiredPower: true, idempotencyKey: 'power-1' } as const
    const first = store.commandDevice('device:lamp', input)
    const second = store.commandDevice('device:lamp', { ...input, idempotencyKey: 'power-2' })
    await Promise.resolve()
    expect(api.commandHomeDevice).toHaveBeenCalledTimes(1)
    await store.refreshDevice('device:fan', { bindingId: 'binding:fan', externalId: 'fan.office',
      requestedAt: '2026-07-15T02:00:00Z', idempotencyKey: 'refresh-1' })
    pending.resolve({ intent: {}, policyDecision: {}, workflow })
    await Promise.all([first, second])
    expect(store.selectedWorkflowId).toBe('workflow:two')
    expect(Object.keys(store.workflows)).toEqual(expect.arrayContaining(['workflow:one', 'workflow:two', 'workflow:refresh']))
  })

  it('keeps only public normalized DTOs and never persists credentials or provider command material', async () => {
    const store = useHomeStore()
    await store.loadDashboard()
    expect(Object.keys(store)).not.toEqual(expect.arrayContaining(['token', 'credential', 'service', 'serviceData']))
    expect(JSON.stringify(store.$state)).not.toMatch(/access_token|refresh_token|service_data|credentialFingerprint/i)
  })

  it('records authoritative workflow review and inventory adjustment responses', async () => {
    api.reviewHomeWorkflow.mockResolvedValue({ ...workflow, state: 'preparing', steps: [] })
    api.adjustHomeInventory.mockResolvedValue({ disposition: 'applied', item: { ...item, quantity: 0 }, entry: {} })
    const store = useHomeStore()
    await store.loadDashboard()
    await store.adjustInventory(item.id, { delta: -1, reason: 'Used', occurredAt: '2026-07-15T02:00:00Z',
      idempotencyKey: 'adjust-1' })
    await store.reviewWorkflow(workflow.id, { action: 'approve' })
    expect(store.inventory[0].quantity).toBe(0)
    expect(store.selectedWorkflow?.state).toBe('preparing')
  })

  it('invalidates in-flight state on reset without changing caller results', async () => {
    const pending = deferred<any>()
    api.fetchHomeOverview.mockImplementationOnce(() => pending.promise)
    const store = useHomeStore()
    const load = store.loadOverview()
    store.$reset()
    pending.resolve(overview)
    await expect(load).resolves.toEqual(overview)
    expect(store.overview).toBeNull()
    expect(store.loading).toBe(false)
  })
})
