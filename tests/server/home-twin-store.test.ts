import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HomeIdentityConflictError,
  HomeTwinStore,
  HomeValidationError,
  HomeVersionConflictError,
} from '../../packages/server/src/services/hermes/home'
import { initPersonalTwinSchema } from '../../packages/server/src/services/hermes/personal-twin'

describe('home twin store', () => {
  let db: DatabaseSync
  let store: HomeTwinStore

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(db)
    store = new HomeTwinStore(db)
  })

  afterEach(() => db.close())

  it('creates and version-updates spaces while enforcing parents and canonical safe JSON', () => {
    const home = store.upsertSpace({
      id: 'space:home', kind: 'home', name: 'Home', attributes: { timezone: 'Asia/Shanghai' }, expectedVersion: 0,
    })
    expect(home).toMatchObject({ id: 'space:home', version: 1, parentSpaceId: null })

    const room = store.upsertSpace({
      id: 'space:living-room', kind: 'room', name: 'Living Room', parentSpaceId: home.id,
      attributes: { z: 1, a: { enabled: true } }, expectedVersion: 0,
    })
    expect(room.attributes).toEqual({ a: { enabled: true }, z: 1 })
    expect(db.prepare("SELECT attributes_json FROM twin_home_spaces WHERE space_id='space:living-room'").get())
      .toEqual({ attributes_json: '{"a":{"enabled":true},"z":1}' })

    const updated = store.upsertSpace({ ...room, name: 'Lounge', expectedVersion: 1 })
    expect(updated).toMatchObject({ name: 'Lounge', version: 2 })
    expect(() => store.upsertSpace({ ...room, name: 'Stale', expectedVersion: 1 })).toThrow(HomeVersionConflictError)
    expect(() => store.upsertSpace({ ...home, parentSpaceId: room.id, expectedVersion: 1 })).toThrow(/cycle/i)
    expect(() => store.upsertSpace({
      id: 'space:orphan', kind: 'room', name: 'Orphan', parentSpaceId: 'space:missing', expectedVersion: 0,
    })).toThrow(/parent/i)
    expect(() => store.upsertSpace({
      id: 'space:poison', kind: 'room', name: 'Poison',
      attributes: JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>, expectedVersion: 0,
    })).toThrow(HomeValidationError)
  })

  it('stores objects, devices, and exact provider bindings with optimistic versions', () => {
    store.upsertSpace({ id: 'space:kitchen', kind: 'room', name: 'Kitchen', expectedVersion: 0 })
    const object = store.upsertObject({
      id: 'object:fridge', kind: 'appliance', name: 'Fridge', spaceId: 'space:kitchen', expectedVersion: 0,
    })
    const device = store.upsertDevice({
      id: 'device:kitchen-light', name: 'Kitchen Light', deviceClass: 'light', spaceId: 'space:kitchen',
      availability: 'available', attributes: { manufacturer: 'Example' }, expectedVersion: 0,
    })
    const binding = store.upsertBinding({
      id: 'binding:kitchen-light', deviceId: device.id, provider: 'home-assistant', externalId: 'light.kitchen',
      capabilities: ['level', 'power', 'power'], metadata: { areaId: 'kitchen' }, expectedVersion: 0,
    })

    expect(object.spaceId).toBe('space:kitchen')
    expect(binding.capabilities).toEqual(['level', 'power'])
    expect(store.listDevices({ spaceId: 'space:kitchen' })).toEqual([device])
    expect(store.listBindings({ deviceId: device.id })).toEqual([binding])
    expect(() => store.upsertBinding({
      ...binding, id: 'binding:collision', expectedVersion: 0,
    })).toThrow(HomeIdentityConflictError)
    expect(() => store.upsertBinding({
      id: 'binding:secret', deviceId: device.id, provider: 'home-assistant', externalId: 'light.secret',
      metadata: { access_token: 'must-not-persist' }, expectedVersion: 0,
    })).toThrow(HomeValidationError)
    expect(() => store.upsertDevice({ ...device, availability: 'unavailable', expectedVersion: 7 }))
      .toThrow(HomeVersionConflictError)
  })

  it('applies normalized device state events once and rejects identity-changing replay', () => {
    store.upsertDevice({
      id: 'device:lamp', name: 'Lamp', deviceClass: 'light', availability: 'available', expectedVersion: 0,
    })
    const input = {
      event: {
        id: 'event:ha:101', provider: 'home-assistant', eventId: '101', eventType: 'state_changed',
        occurredAt: '2026-07-14T12:00:00.000Z', receivedAt: '2026-07-14T12:00:00.100Z',
        payload: { entityId: 'light.lamp' },
      },
      states: [{ deviceId: 'device:lamp', key: 'power', value: 'on', observedAt: '2026-07-14T12:00:00.000Z' }],
    }
    const applied = store.applyDeviceStateEvent(input)
    expect(applied.disposition).toBe('applied')
    expect(applied.states[0]).toMatchObject({ value: 'on', version: 1, sourceEventId: 'event:ha:101' })
    const outboxBeforeReplay = db.prepare('SELECT COUNT(*) AS count FROM twin_outbox').get()

    const replay = store.applyDeviceStateEvent(input)
    expect(replay.disposition).toBe('duplicate')
    expect(replay.states[0].version).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM twin_home_provider_events').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM twin_outbox').get()).toEqual(outboxBeforeReplay)

    expect(() => store.applyDeviceStateEvent({
      ...input,
      event: { ...input.event, payload: { entityId: 'light.other' } },
    })).toThrow(HomeIdentityConflictError)
  })

  it('records stale events without regressing newer state and uses event id as the timestamp tie-breaker', () => {
    store.upsertDevice({
      id: 'device:thermostat', name: 'Thermostat', deviceClass: 'climate', availability: 'available', expectedVersion: 0,
    })
    const apply = (id: string, eventId: string, occurredAt: string, value: number) => store.applyDeviceStateEvent({
      event: {
        id, provider: 'home-assistant', eventId, eventType: 'state_changed', occurredAt,
        receivedAt: '2026-07-14T12:01:00.000Z', payload: { value },
      },
      states: [{ deviceId: 'device:thermostat', key: 'temperature', value, observedAt: occurredAt }],
    })

    expect(apply('event:ha:200', '200', '2026-07-14T12:00:00.000Z', 23).disposition).toBe('applied')
    expect(apply('event:ha:199', '199', '2026-07-14T11:59:59.000Z', 18).disposition).toBe('ignored')
    expect(apply('event:ha:150', '150', '2026-07-14T12:00:00.000Z', 19).disposition).toBe('ignored')
    expect(apply('event:ha:201', '201', '2026-07-14T12:00:00.000Z', 24).disposition).toBe('applied')

    expect(store.listDeviceStates({ deviceId: 'device:thermostat' })).toEqual([
      expect.objectContaining({ key: 'temperature', value: 24, version: 2, sourceEventId: 'event:ha:201' }),
    ])
    expect((db.prepare('SELECT event_id,status FROM twin_home_provider_events ORDER BY event_id').all()))
      .toEqual([
        { event_id: '150', status: 'ignored' },
        { event_id: '199', status: 'ignored' },
        { event_id: '200', status: 'applied' },
        { event_id: '201', status: 'applied' },
      ])
  })

  it('maintains an idempotent inventory ledger and low-stock projection', () => {
    const item = store.upsertInventoryItem({
      id: 'inventory:coffee', name: 'Coffee Beans', unit: 'g', initialQuantity: 500,
      lowStockThreshold: 100, attributes: { brand: 'Example' }, expectedVersion: 0,
    })
    expect(item).toMatchObject({ quantity: 500, version: 1 })
    expect(store.listInventoryItems({ lowStockOnly: true })).toEqual([])

    const adjustment = {
      id: 'inventory-entry:coffee-1', itemId: item.id, delta: -450, reason: 'refill grinder',
      source: 'home-user', sourceId: 'adjustment-1', occurredAt: '2026-07-14T12:30:00.000Z',
    }
    const applied = store.adjustInventory(adjustment)
    expect(applied).toMatchObject({ disposition: 'applied', item: { quantity: 50, version: 2 } })
    expect(store.listInventoryItems({ lowStockOnly: true })).toEqual([expect.objectContaining({ id: item.id, quantity: 50 })])
    const outboxBeforeReplay = db.prepare('SELECT COUNT(*) AS count FROM twin_outbox').get()

    const replay = store.adjustInventory(adjustment)
    expect(replay.disposition).toBe('duplicate')
    expect(db.prepare('SELECT COUNT(*) AS count FROM twin_home_inventory_ledger').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM twin_outbox').get()).toEqual(outboxBeforeReplay)
    expect(() => store.adjustInventory({ ...adjustment, delta: -1 })).toThrow(HomeIdentityConflictError)
    expect(() => store.adjustInventory({
      ...adjustment, id: 'inventory-entry:coffee-2', sourceId: 'adjustment-2', delta: -51,
    })).toThrow(/negative/i)

    expect(db.prepare(`SELECT value_json,version FROM twin_projections
      WHERE projection_key='home.inventory.low_stock' AND subject_id=?`).get(item.id)).toEqual({
      value_json: '{"isLowStock":true,"quantity":50,"threshold":100,"unit":"g"}', version: 2,
    })
    expect(db.prepare(`SELECT event_type FROM twin_events WHERE source='home-user' AND source_id='adjustment-1'`).get())
      .toEqual({ event_type: 'home.inventory.adjusted' })
    expect(() => db.prepare("UPDATE twin_home_inventory_ledger SET reason='rewrite'").run()).toThrow(/immutable/i)
  })

  it('mirrors placement and provider state changes into generic Twin events and outbox', () => {
    const room = store.upsertSpace({ id: 'space:office', kind: 'room', name: 'Office', expectedVersion: 0 })
    const object = store.upsertObject({
      id: 'object:desk', kind: 'furniture', name: 'Desk', spaceId: room.id, expectedVersion: 0,
    })
    const device = store.upsertDevice({
      id: 'device:desk-lamp', name: 'Desk Lamp', deviceClass: 'light', spaceId: room.id,
      availability: 'available', expectedVersion: 0,
    })
    store.applyDeviceStateEvent({
      event: {
        id: 'event:ha:301', provider: 'home-assistant', eventId: '301', eventType: 'state_changed',
        occurredAt: '2026-07-14T13:00:00.000Z', receivedAt: '2026-07-14T13:00:00.100Z',
        payload: { entityId: 'light.desk' },
      },
      states: [{ deviceId: device.id, key: 'power', value: 'on', observedAt: '2026-07-14T13:00:00.000Z' }],
    })

    expect((db.prepare(`SELECT id FROM twin_entities WHERE id IN (?,?,?) ORDER BY id`).all(room.id, object.id, device.id)))
      .toEqual([{ id: device.id }, { id: object.id }, { id: room.id }])
    expect((db.prepare(`SELECT subject_id,predicate,object_id,valid_to FROM twin_relations
      WHERE predicate='home.located_in' ORDER BY subject_id`).all())).toEqual([
      { subject_id: device.id, predicate: 'home.located_in', object_id: room.id, valid_to: null },
      { subject_id: object.id, predicate: 'home.located_in', object_id: room.id, valid_to: null },
    ])
    expect((db.prepare(`SELECT event_type FROM twin_events WHERE event_type LIKE 'home.%' ORDER BY event_type`).all()))
      .toEqual([
        { event_type: 'home.placement.changed' },
        { event_type: 'home.placement.changed' },
        { event_type: 'home.provider.state_changed' },
      ])
    expect(db.prepare(`SELECT COUNT(*) AS count FROM twin_outbox WHERE topic='twin.event.recorded'`).get())
      .toEqual({ count: 3 })

    store.upsertObject({ ...object, spaceId: null, expectedVersion: 1 })
    expect(db.prepare(`SELECT valid_to FROM twin_relations WHERE subject_id=? AND predicate='home.located_in'`).get(object.id))
      .toEqual({ valid_to: expect.any(String) })
  })
})
