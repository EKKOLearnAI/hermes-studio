import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const NOW = '2026-07-01T08:00:00.000Z'
const LATER = '2026-07-02T08:00:00.000Z'

function createLegacyDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE home_layouts (
      profile TEXT NOT NULL, version INTEGER NOT NULL, layout_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE home_rooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, floor_name TEXT NOT NULL,
      x REAL, y REAL, w REAL, h REAL, color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE home_furniture (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL, furniture_type TEXT NOT NULL,
      x REAL, y REAL, w REAL, h REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE home_compartments (
      id TEXT PRIMARY KEY, furniture_id TEXT NOT NULL, name TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE home_inventory_batches (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL,
      expiry_date TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE home_devices (
      id TEXT PRIMARY KEY, external_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL,
      room_id TEXT, capabilities_json TEXT NOT NULL, state_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE home_placements (
      id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      room_id TEXT, furniture_id TEXT, compartment_id TEXT, x REAL, y REAL, z REAL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE home_inventory_ledger (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, event_type TEXT NOT NULL,
      quantity_delta REAL NOT NULL, actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE home_device_states (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, capability TEXT NOT NULL,
      state_json TEXT NOT NULL, observed_at TEXT NOT NULL
    );
    CREATE TABLE home_device_bindings (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO home_layouts VALUES(?,?,?,?,?)').run(
    'default', 4, JSON.stringify({ floors: [{ name: '1F', width: 12, height: 8 }], activeFloor: '1F' }), NOW, LATER,
  )
  db.prepare('INSERT INTO home_rooms VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('living', 'Living Room', '1F', 1, 2, 6, 4, '#aabbcc', NOW, LATER)
  db.prepare('INSERT INTO home_furniture VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('cabinet', 'living', 'Cabinet', 'storage', 2, 3, 1, 2, NOW, LATER)
  db.prepare('INSERT INTO home_compartments VALUES(?,?,?,?,?)').run('drawer', 'cabinet', 'Top Drawer', NOW, LATER)
  db.prepare('INSERT INTO home_inventory_batches VALUES(?,?,?,?,?,?,?,?)')
    .run('batteries', 'AA Batteries', 1, '节', '2027-01-01', 'emergency stock', NOW, LATER)
  db.prepare('INSERT INTO home_inventory_ledger VALUES(?,?,?,?,?,?,?)')
    .run('ledger-use', 'batteries', 'consume', -1, 'user', JSON.stringify({ reason: 'remote control' }), LATER)
  db.prepare('INSERT INTO home_devices VALUES(?,?,?,?,?,?,?,?,?)').run(
    'lamp', 'light.living', 'home_assistant', 'Living Lamp', 'living',
    JSON.stringify(['switch.on_off', 'light.brightness']), JSON.stringify({ state: 'on', brightness: 128 }), NOW, LATER,
  )
  db.prepare('INSERT INTO home_devices VALUES(?,?,?,?,?,?,?,?,?)').run(
    'door', 'cover.front_door', 'home_assistant', 'Front Door', 'living',
    JSON.stringify(['cover.position']), JSON.stringify({ state: 'closed' }), NOW, LATER,
  )
  db.prepare('INSERT INTO home_device_states VALUES(?,?,?,?,?)')
    .run('lamp-level', 'lamp', 'light.brightness', JSON.stringify({ value: 40 }), LATER)
  db.prepare('INSERT INTO home_device_bindings VALUES(?,?,?,?,?,?)')
    .run('bind-lamp-cabinet', 'lamp', 'furniture', 'cabinet', NOW, LATER)
  const placement = db.prepare('INSERT INTO home_placements VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  placement.run('place-inventory', 'inventory_batch', 'batteries', 'living', 'cabinet', 'drawer', 0.1, 0.2, 0.3, NOW, LATER)
  placement.run('place-lamp', 'device', 'lamp', 'living', null, null, 3, 4, 0, NOW, LATER)
  placement.run('place-object', 'object', 'photo-frame', 'living', null, null, 4, 2, 1, NOW, LATER)
  return db
}

describe('home legacy migration', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-home-migration-'))
    process.env.HERMES_HOME = hermesHome
    mkdirSync(hermesHome, { recursive: true })
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('imports the legacy hierarchy, ledger, placements, devices, and provenance exactly once', async () => {
    const legacyPath = join(hermesHome, 'home_state.db')
    createLegacyDatabase(legacyPath).close()
    const { HomeTwinStore, getLegacyHomeLayout, getLegacyHomeMap, getLegacyHomeOverview,
      syncLegacyHomeTwinSources } = await import('../../packages/server/src/services/hermes/home')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin/database')

    const first = syncLegacyHomeTwinSources({ profiles: ['default'] })
    expect(first.status).toBe('completed')
    expect(first.version).toMatch(/^home-migration-v\d+$/)
    expect(first.counts).toMatchObject({
      profiles: 1, layouts: 1, spaces: 5, objects: 5, inventory: 1,
      ledger: 1, devices: 2, bindings: 2, stateEvents: 3, placements: 3, skipped: 0,
    })
    expect(first).not.toHaveProperty('sources')

    const imported = withPersonalTwinDb(db => {
      const store = new HomeTwinStore(db)
      const spaces = store.listSpaces({ limit: 200 })
      const room = spaces.find(item => item.name === 'Living Room')!
      const cabinet = spaces.find(item => item.name === 'Cabinet')!
      const drawer = spaces.find(item => item.name === 'Top Drawer')!
      const inventory = store.listInventoryItems({ limit: 200 })[0]
      const devices = store.listDevices({ limit: 200 })
      const lamp = devices.find(item => item.name === 'Living Lamp')!
      const door = devices.find(item => item.name === 'Front Door')!
      return {
        spaces, room, cabinet, drawer, inventory, devices,
        lampBinding: store.listBindings({ deviceId: lamp.id })[0],
        doorBinding: store.listBindings({ deviceId: door.id })[0],
        lampStates: store.listDeviceStates({ deviceId: lamp.id }),
        doorStates: store.listDeviceStates({ deviceId: door.id }),
        objects: store.listObjects({ limit: 200 }),
        ledger: db.prepare('SELECT * FROM twin_home_inventory_ledger').all(),
        outboxCount: Number((db.prepare('SELECT COUNT(*) AS count FROM twin_outbox').get() as { count: number }).count),
      }
    })

    expect(imported.room.parentSpaceId).toBe(imported.spaces.find(item => item.name === '1F')?.id)
    expect(imported.cabinet.parentSpaceId).toBe(imported.room.id)
    expect(imported.drawer.parentSpaceId).toBe(imported.cabinet.id)
    expect(imported.room.attributes).toMatchObject({
      legacySource: { system: 'home-state-v1', profile: 'default', table: 'home_rooms', id: 'living' },
      geometry: { x: 1, y: 2, w: 6, h: 4 },
    })
    expect(imported.inventory).toMatchObject({ name: 'AA Batteries', unit: 'piece', quantity: 1 })
    expect(imported.inventory.attributes).toMatchObject({
      legacyUnit: '节',
      placement: { spaceId: imported.drawer.id, roomId: 'living', furnitureId: 'cabinet', compartmentId: 'drawer' },
    })
    expect(imported.ledger).toHaveLength(1)
    expect(imported.lampBinding.capabilities).toEqual(['level', 'power'])
    expect(imported.devices.find(item => item.name === 'Living Lamp')?.attributes).toMatchObject({
      legacyTargetBindings: [expect.objectContaining({ id: 'bind-lamp-cabinet', targetType: 'furniture',
        targetId: 'cabinet', legacySource: expect.objectContaining({ table: 'home_device_bindings', id: 'bind-lamp-cabinet' }) })],
    })
    expect(imported.doorBinding.capabilities).toEqual([])
    expect(imported.lampStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'power', value: true }),
      expect.objectContaining({ key: 'level', value: 40 }),
    ]))
    expect(imported.doorStates).toContainEqual(expect.objectContaining({ key: 'state', value: 'closed' }))
    expect(imported.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'layout-document', attributes: expect.objectContaining({ document: expect.any(Object) }) }),
      expect.objectContaining({ kind: 'object', name: 'photo-frame' }),
    ]))
    const legacyOverview = getLegacyHomeOverview('default')
    expect(legacyOverview).toMatchObject({
      profile: 'default', rooms: [{ id: 'living', name: 'Living Room', floorName: '1F' }],
      furniture: [{ id: 'cabinet', roomId: 'living', furnitureType: 'storage' }],
      compartments: [{ id: 'drawer', furnitureId: 'cabinet' }],
      inventory: [{ id: 'batteries', quantity: 1, unit: '节' }],
      devices: expect.arrayContaining([
        expect.objectContaining({ id: 'lamp', externalId: 'light.living', capabilities: ['switch.on_off', 'light.brightness'] }),
        expect.objectContaining({ id: 'door', externalId: 'cover.front_door', capabilities: ['cover.position'] }),
      ]),
      placements: expect.arrayContaining([
        expect.objectContaining({ id: 'place-inventory', targetType: 'inventory_batch', targetId: 'batteries' }),
        expect.objectContaining({ id: 'place-lamp', targetType: 'device', targetId: 'lamp' }),
      ]),
    })
    expect(getLegacyHomeMap('default')).not.toHaveProperty('inventory')
    expect(getLegacyHomeLayout('default')).toMatchObject({ activeFloor: '1F' })

    const versions = withPersonalTwinDb(db => ({
      spaces: db.prepare('SELECT space_id,version FROM twin_home_spaces ORDER BY space_id').all(),
      objects: db.prepare('SELECT object_id,version FROM twin_home_objects ORDER BY object_id').all(),
      inventory: db.prepare('SELECT item_id,quantity,version FROM twin_home_inventory_items').all(),
      devices: db.prepare('SELECT device_id,version FROM twin_home_devices ORDER BY device_id').all(),
    }))
    expect(syncLegacyHomeTwinSources({ profiles: ['default'] })).toEqual(first)
    withPersonalTwinDb(db => {
      expect(db.prepare('SELECT space_id,version FROM twin_home_spaces ORDER BY space_id').all()).toEqual(versions.spaces)
      expect(db.prepare('SELECT object_id,version FROM twin_home_objects ORDER BY object_id').all()).toEqual(versions.objects)
      expect(db.prepare('SELECT item_id,quantity,version FROM twin_home_inventory_items').all()).toEqual(versions.inventory)
      expect(db.prepare('SELECT device_id,version FROM twin_home_devices ORDER BY device_id').all()).toEqual(versions.devices)
      expect(db.prepare('SELECT COUNT(*) AS count FROM twin_home_inventory_ledger').get()).toEqual({ count: 1 })
      expect(Number((db.prepare('SELECT COUNT(*) AS count FROM twin_outbox').get() as { count: number }).count)).toBe(imported.outboxCount)
    })
  })

  it('fails closed on sensitive legacy state without persisting source content', async () => {
    const db = createLegacyDatabase(join(hermesHome, 'home_state.db'))
    db.prepare("UPDATE home_devices SET state_json=? WHERE id='lamp'")
      .run(JSON.stringify({ state: 'on', access_token: 'never-persist-this' }))
    db.close()
    const { syncLegacyHomeTwinSources } = await import('../../packages/server/src/services/hermes/home')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin/database')

    expect(() => syncLegacyHomeTwinSources({ profiles: ['default'] })).toThrowError('HOME_MIGRATION_SOURCE_UNAVAILABLE')
    const stored = withPersonalTwinDb(db => JSON.stringify({
      spaces: db.prepare('SELECT * FROM twin_home_spaces').all(),
      devices: db.prepare('SELECT * FROM twin_home_devices').all(),
      imports: db.prepare("SELECT status,error FROM twin_import_runs WHERE source='legacy-home-state'").all(),
    }))
    expect(stored).not.toContain('never-persist-this')
    expect(JSON.parse(stored)).toEqual({ spaces: [], devices: [], imports: [] })
  })
})
