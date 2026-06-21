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
  createHealthRecord: vi.fn(() => ({ id: 'record-1', kind: 'weight' })),
  listHealthWorkouts: vi.fn(() => []),
  createHealthWorkout: vi.fn(() => ({ id: 'workout-1' })),
  listHealthFoodItems: vi.fn(() => []),
  listHealthFoodLogs: vi.fn(() => []),
  createHealthFoodLog: vi.fn(() => ({ id: 'food-log-1' })),
  getTodayHealthPlan: vi.fn(() => ({ id: 'plan-1' })),
  createHealthCheckIn: vi.fn(() => ({ id: 'checkin-1' })),
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
})
