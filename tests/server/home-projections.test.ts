import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeAndPersistHomeProjections,
  HomeTwinStore,
} from '../../packages/server/src/services/hermes/home'
import { initPersonalTwinSchema } from '../../packages/server/src/services/hermes/personal-twin'

describe('home projections and safe-action rules', () => {
  let db: DatabaseSync
  let store: HomeTwinStore

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(db)
    store = new HomeTwinStore(db)
    store.upsertSpace({ id: 'space:office', kind: 'room', name: 'Office', expectedVersion: 0 })
    device(store, 'device:temperature', 'Office Temperature', 'temperature', 'available')
    device(store, 'device:humidity', 'Office Humidity', 'humidity', 'available')
    device(store, 'device:lamp', 'Office Lamp', 'light', 'unavailable')
    observed(store, 'device:temperature', 'event:temperature', 'value', 23, '2026-07-15T11:50:00Z')
    observed(store, 'device:humidity', 'event:humidity', 'value', 85, '2026-07-15T08:00:00Z')
    store.upsertInventoryItem({
      id: 'inventory:coffee', name: 'Coffee Beans', unit: 'bag', initialQuantity: 2,
      lowStockThreshold: 5, expectedVersion: 0,
    })
  })

  afterEach(() => db.close())

  it('persists deterministic explainable projections and emits candidates without executing them', () => {
    const eventsBefore = count(db, 'twin_events')
    const first = computeAndPersistHomeProjections(store, { computedAt: '2026-07-15T12:00:00Z' })

    expect(first.projections).toHaveLength(11)
    expect(first.projections.find(item => item.key === 'home.room.environment')).toMatchObject({
      subjectId: 'space:office',
      value: {
        state: {
          deviceCounts: { total: 3, available: 2, unavailable: 1, unknown: 0 },
          metrics: {
            humidity: { deviceId: 'device:humidity', value: 85, unit: '%', freshness: 'stale' },
            temperature: { deviceId: 'device:temperature', value: 23, unit: '°C', freshness: 'fresh' },
          },
        },
      },
    })
    expect(first.projections.find(item => item.key === 'home.device.maintenance'
      && item.subjectId === 'device:humidity')?.value).toMatchObject({
      state: { required: true, signals: [{ code: 'STALE_SENSOR' }] },
    })
    expect(first.projections.find(item => item.key === 'home.inventory.warning')?.value).toMatchObject({
      state: { level: 'low', quantity: 2, threshold: 5, unit: 'bag' },
    })
    expect(first.candidates.map(candidate => ({
      kind: candidate.kind, subjectId: candidate.subjectId, capabilityId: candidate.capabilityId,
      target: candidate.target, reasons: candidate.reasonCodes,
    }))).toEqual([
      {
        kind: 'refresh_device', subjectId: 'device:lamp', capabilityId: 'home.device.refresh',
        target: 'home:device:device:lamp', reasons: ['DEVICE_UNAVAILABLE'],
      },
      {
        kind: 'refresh_device', subjectId: 'device:humidity', capabilityId: 'home.device.refresh',
        target: 'home:device:device:humidity', reasons: ['STALE_SENSOR'],
      },
      {
        kind: 'review_inventory', subjectId: 'inventory:coffee', capabilityId: null,
        target: null, reasons: ['INVENTORY_LOW'],
      },
    ])
    expect(first.candidates.every(candidate => candidate.automatic === false)).toBe(true)
    expect(count(db, 'twin_events')).toBe(eventsBefore)
    expect(count(db, 'twin_projections', "projection_key LIKE 'home.%'")).toBe(12)

    const versions = first.projections.map(item => [item.key, item.subjectId, item.version])
    const replay = computeAndPersistHomeProjections(store, { computedAt: '2026-07-15T12:00:00Z' })
    expect(replay.projections.map(item => [item.key, item.subjectId, item.version])).toEqual(versions)
    expect(replay.candidates).toEqual(first.candidates)
  })
})

function device(
  store: HomeTwinStore,
  id: string,
  name: string,
  deviceClass: string,
  availability: 'available' | 'unavailable' | 'unknown',
): void {
  store.upsertDevice({
    id, name, deviceClass, availability, spaceId: 'space:office',
    attributes: deviceClass === 'temperature' ? { unit: '°C' } : deviceClass === 'humidity' ? { unit: '%' } : {},
    expectedVersion: 0,
  })
}

function observed(
  store: HomeTwinStore,
  deviceId: string,
  eventId: string,
  key: string,
  value: unknown,
  observedAt: string,
): void {
  store.applyDeviceStateEvent({
    event: {
      id: eventId, provider: 'home-assistant', eventId, eventType: 'state_changed',
      occurredAt: observedAt, receivedAt: observedAt, payload: { deviceId },
    },
    states: [{ deviceId, key, value, observedAt }],
  })
}

function count(db: DatabaseSync, table: string, where = '1=1'): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count
}
