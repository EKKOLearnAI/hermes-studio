// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
}))

import {
  createHealthCheckIn,
  createHealthFoodLog,
  createHealthRecord,
  createHealthScaleReading,
  createHealthWorkout,
  fetchScaleSyncSettings,
  fetchHealthBodyMap,
  fetchHealthFoodItems,
  fetchHealthFoodLogs,
  fetchHealthOverview,
  fetchHealthProfile,
  fetchHealthRecords,
  fetchHealthScaleReadings,
  fetchHealthTodayPlan,
  fetchHealthWorkouts,
  updateHealthBodyMap,
  updateHealthProfile,
  runScaleSync,
  updateScaleSyncSettings,
} from '../../packages/client/src/api/hermes/health-state'

describe('Health State API', () => {
  beforeEach(() => {
    mockRequest.mockReset()
  })

  it('fetches health resources with optional profile params', async () => {
    mockRequest
      .mockResolvedValueOnce({ overview: { profile: 'default' } })
      .mockResolvedValueOnce({ profile: { weightKg: 80 } })
      .mockResolvedValueOnce({ bodyMap: [] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ latest: null, readings: [], total: 0 })
      .mockResolvedValueOnce({ workouts: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ logs: [] })
      .mockResolvedValueOnce({ plan: null })
      .mockResolvedValueOnce({ settings: { enabled: false } })

    await fetchHealthOverview({ profile: 'default', includeRecords: false })
    await fetchHealthProfile('default')
    await fetchHealthBodyMap('default')
    await fetchHealthRecords('default')
    await fetchHealthScaleReadings({ profile: 'default', limit: 20 })
    await fetchHealthWorkouts('default')
    await fetchHealthFoodItems('default')
    await fetchHealthFoodLogs('default')
    await fetchHealthTodayPlan('default')
    await fetchScaleSyncSettings('default')

    expect(mockRequest.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/health/overview?profile=default&includeRecords=false',
      '/api/hermes/health/profile?profile=default',
      '/api/hermes/health/body-map?profile=default',
      '/api/hermes/health/records?profile=default',
      '/api/hermes/health/scale-readings?profile=default&limit=20',
      '/api/hermes/health/workouts?profile=default',
      '/api/hermes/health/food/items?profile=default',
      '/api/hermes/health/food/logs?profile=default',
      '/api/hermes/health/today-plan?profile=default',
      '/api/hermes/health/scale-sync?profile=default',
    ])
  })

  it('writes health resources with JSON bodies and profile params', async () => {
    mockRequest
      .mockResolvedValueOnce({ profile: { weightTargetKg: 75 } })
      .mockResolvedValueOnce({ bodyMap: [{ region: 'shoulders' }] })
      .mockResolvedValueOnce({ record: { id: 'record-1' } })
      .mockResolvedValueOnce({ workout: { id: 'workout-1' } })
      .mockResolvedValueOnce({ log: { id: 'food-log-1' } })
      .mockResolvedValueOnce({ checkIn: { id: 'checkin-1' } })
      .mockResolvedValueOnce({ reading: { id: 'scale-1' } })
      .mockResolvedValueOnce({ settings: { enabled: true } })
      .mockResolvedValueOnce({ result: { status: 'skipped', importedCount: 0, readings: [] } })

    await updateHealthProfile({ weightTargetKg: 75 }, 'default')
    await updateHealthBodyMap([{ region: 'shoulders' }], 'default')
    await createHealthRecord({ kind: 'weight', value: 80 }, 'default')
    await createHealthWorkout({ title: 'Push', durationMinutes: 45 }, 'default')
    await createHealthFoodLog({ meal: 'lunch', nutrition: { protein: 50 } }, 'default')
    await createHealthCheckIn({ energy: 4 }, 'default')
    await createHealthScaleReading({ weightKg: 85, bodyFatPercent: 23.9 }, 'default')
    await updateScaleSyncSettings({ enabled: true, username: 'xiaomi-user' }, 'default')
    await runScaleSync('default')

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/health/profile?profile=default', { method: 'PUT', body: JSON.stringify({ weightTargetKg: 75 }) }],
      ['/api/hermes/health/body-map?profile=default', { method: 'PUT', body: JSON.stringify([{ region: 'shoulders' }]) }],
      ['/api/hermes/health/records?profile=default', { method: 'POST', body: JSON.stringify({ kind: 'weight', value: 80 }) }],
      ['/api/hermes/health/workouts?profile=default', { method: 'POST', body: JSON.stringify({ title: 'Push', durationMinutes: 45 }) }],
      ['/api/hermes/health/food/logs?profile=default', { method: 'POST', body: JSON.stringify({ meal: 'lunch', nutrition: { protein: 50 } }) }],
      ['/api/hermes/health/check-ins?profile=default', { method: 'POST', body: JSON.stringify({ energy: 4 }) }],
      ['/api/hermes/health/scale-readings?profile=default', { method: 'POST', body: JSON.stringify({ weightKg: 85, bodyFatPercent: 23.9 }) }],
      ['/api/hermes/health/scale-sync?profile=default', { method: 'PUT', body: JSON.stringify({ enabled: true, username: 'xiaomi-user' }) }],
      ['/api/hermes/health/scale-sync/run?profile=default', { method: 'POST', body: JSON.stringify({}) }],
    ])
  })
})
