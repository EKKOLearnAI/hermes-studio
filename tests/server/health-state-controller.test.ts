import { beforeEach, describe, expect, it, vi } from 'vitest'

const listUserProfiles = vi.fn()

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles,
}))

vi.mock('../../packages/server/src/services/hermes/health-state', () => ({
  getHealthOverview: vi.fn(() => ({ profile: 'default' })),
  getHealthProfile: vi.fn(() => ({ displayName: null })),
  updateHealthProfile: vi.fn(() => ({ displayName: 'User' })),
  getHealthBodyMap: vi.fn(() => []),
  updateHealthBodyMap: vi.fn(() => [{ region: 'shoulders' }]),
  listHealthRecords: vi.fn(() => []),
  listHealthScaleReadings: vi.fn(() => ({ latest: null, readings: [], total: 0 })),
  createHealthRecord: vi.fn(() => ({ id: 'record-1', kind: 'weight' })),
  listHealthWorkouts: vi.fn(() => []),
  createHealthWorkout: vi.fn(() => ({ id: 'workout-1' })),
  listHealthFoodItems: vi.fn(() => []),
  listHealthFoodLogs: vi.fn(() => []),
  createHealthFoodLog: vi.fn(() => ({ id: 'food-log-1' })),
  getTodayHealthPlan: vi.fn(() => ({ id: 'plan-1' })),
  createHealthCheckIn: vi.fn(() => ({ id: 'checkin-1' })),
  createHealthScaleReading: vi.fn(() => ({ id: 'scale-1', kind: 'scale_reading' })),
}))

vi.mock('../../packages/server/src/services/hermes/scale-sync', () => ({
  getScaleSyncSettings: vi.fn(() => Promise.resolve({ enabled: true, configured: true })),
  updateScaleSyncSettings: vi.fn(() => Promise.resolve({ enabled: true, configured: true })),
  runScaleSync: vi.fn(() => Promise.resolve({ status: 'skipped', reason: 'missing_scaleconnect_path', importedCount: 0, readings: [] })),
}))

describe('health state controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listUserProfiles.mockReset()
  })

  it('rejects a profile that is not available to the current user', async () => {
    listUserProfiles.mockReturnValue([{ profile_name: 'work' }])
    const { overview } = await import('../../packages/server/src/controllers/hermes/health-state')
    const ctx: any = {
      query: { profile: 'private' },
      state: { user: { id: 'user-1', role: 'user' } },
      body: null,
    }

    await overview(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Profile "private" is not available for this user' })
  })

  it('creates a health record through the service', async () => {
    const service = await import('../../packages/server/src/services/hermes/health-state')
    const { createRecord } = await import('../../packages/server/src/controllers/hermes/health-state')
    const ctx: any = {
      params: {},
      query: { profile: 'default' },
      request: { body: { kind: 'weight', value: 82.4, unit: 'kg' } },
      state: { user: { id: 'admin', role: 'super_admin', username: 'admin' } },
      body: null,
    }

    await createRecord(ctx)

    expect(service.createHealthRecord).toHaveBeenCalledWith({ kind: 'weight', value: 82.4, unit: 'kg' }, 'admin', 'default')
    expect(ctx.body).toEqual({ record: { id: 'record-1', kind: 'weight' } })
  })

  it('creates a scale reading through the service', async () => {
    const service = await import('../../packages/server/src/services/hermes/health-state')
    const { createScaleReading } = await import('../../packages/server/src/controllers/hermes/health-state')
    const payload = { weightKg: 85, bodyFatPercent: 23.9, sourceDevice: 'Mi Body Composition Scale S400' }
    const ctx: any = {
      params: {},
      query: { profile: 'default' },
      request: { body: payload },
      state: { user: { id: 'admin', role: 'super_admin', username: 'admin' } },
      body: null,
    }

    await createScaleReading(ctx)

    expect(service.createHealthScaleReading).toHaveBeenCalledWith(payload, 'admin', 'default')
    expect(ctx.body).toEqual({ reading: { id: 'scale-1', kind: 'scale_reading' } })
  })

  it('lists scale readings through the service with a bounded limit', async () => {
    const service = await import('../../packages/server/src/services/hermes/health-state')
    const { listScaleReadings } = await import('../../packages/server/src/controllers/hermes/health-state')
    const ctx: any = {
      query: { profile: 'default', limit: '12' },
      request: { body: {} },
      state: { user: { id: 'admin', role: 'super_admin', username: 'admin' } },
      body: null,
    }

    await listScaleReadings(ctx)

    expect(service.listHealthScaleReadings).toHaveBeenCalledWith({ profile: 'default', limit: 12 })
    expect(ctx.body).toEqual({ latest: null, readings: [], total: 0 })
  })

  it('updates scale sync settings through the service without exposing profile access', async () => {
    const service = await import('../../packages/server/src/services/hermes/scale-sync')
    const { updateScaleSync } = await import('../../packages/server/src/controllers/hermes/health-state')
    const payload = { enabled: true, username: 'xiaomi-user' }
    const ctx: any = {
      query: { profile: 'default' },
      request: { body: payload },
      state: { user: { id: 'admin', role: 'super_admin', username: 'admin' } },
      body: null,
    }

    await updateScaleSync(ctx)

    expect(service.updateScaleSyncSettings).toHaveBeenCalledWith(payload, 'default')
    expect(ctx.body).toEqual({ settings: { enabled: true, configured: true } })
  })

  it('runs scale sync through the service', async () => {
    const service = await import('../../packages/server/src/services/hermes/scale-sync')
    const { runScaleSyncNow } = await import('../../packages/server/src/controllers/hermes/health-state')
    const ctx: any = {
      query: { profile: 'default' },
      request: { body: {} },
      state: { user: { id: 'admin', role: 'super_admin', username: 'admin' } },
      body: null,
    }

    await runScaleSyncNow(ctx)

    expect(service.runScaleSync).toHaveBeenCalledWith('default', 'admin')
    expect(ctx.body).toEqual({ result: { status: 'skipped', reason: 'missing_scaleconnect_path', importedCount: 0, readings: [] } })
  })
})
