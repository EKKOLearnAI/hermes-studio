import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const HOME_TABLES = [
  'twin_home_command_receipts',
  'twin_home_device_bindings',
  'twin_home_device_states',
  'twin_home_devices',
  'twin_home_inventory_items',
  'twin_home_inventory_ledger',
  'twin_home_objects',
  'twin_home_provider_cursors',
  'twin_home_provider_events',
  'twin_home_spaces',
] as const

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(row => row.name)
}

function indexSignature(db: DatabaseSync, table: string, indexName: string): { unique: number; columns: string[] } | undefined {
  const index = (db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string; unique: number }>)
    .find(candidate => candidate.name === indexName)
  if (!index) return undefined
  const columns = (db.prepare(`PRAGMA index_info('${indexName}')`).all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno)
    .map(column => column.name)
  return { unique: index.unique, columns }
}

describe('home twin schema', () => {
  it('creates the v11 home domain tables with exact columns and identity indexes', async () => {
    const { initPersonalTwinSchema } = await import('../../packages/server/src/services/hermes/personal-twin')
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(db)

    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '11' })
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'twin_home_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name)
    expect(names).toEqual(HOME_TABLES)

    expect(tableColumns(db, 'twin_home_spaces')).toEqual([
      'space_id', 'kind', 'name', 'parent_space_id', 'attributes_json', 'version', 'created_at', 'updated_at',
    ])
    expect(tableColumns(db, 'twin_home_objects')).toEqual([
      'object_id', 'kind', 'name', 'space_id', 'attributes_json', 'version', 'created_at', 'updated_at',
    ])
    expect(tableColumns(db, 'twin_home_inventory_items')).toEqual([
      'item_id', 'name', 'unit', 'quantity', 'low_stock_threshold', 'attributes_json', 'version', 'created_at', 'updated_at',
    ])
    expect(tableColumns(db, 'twin_home_inventory_ledger')).toEqual([
      'entry_id', 'item_id', 'delta', 'resulting_quantity', 'reason', 'source', 'source_id', 'created_at',
    ])
    expect(tableColumns(db, 'twin_home_devices')).toEqual([
      'device_id', 'name', 'device_class', 'space_id', 'availability', 'attributes_json', 'version', 'created_at', 'updated_at',
    ])
    expect(tableColumns(db, 'twin_home_device_bindings')).toEqual([
      'binding_id', 'device_id', 'provider', 'external_id', 'capabilities_json', 'metadata_json', 'version', 'created_at', 'updated_at',
    ])
    expect(tableColumns(db, 'twin_home_device_states')).toEqual([
      'device_id', 'state_key', 'value_json', 'source_event_id', 'observed_at', 'received_at', 'version',
    ])
    expect(tableColumns(db, 'twin_home_provider_events')).toEqual([
      'provider_event_id', 'provider', 'event_id', 'event_type', 'occurred_at', 'received_at', 'payload_json', 'status', 'error_code',
    ])
    expect(tableColumns(db, 'twin_home_provider_cursors')).toEqual([
      'provider', 'cursor_json', 'connection_status', 'last_event_at', 'version', 'updated_at',
    ])
    expect(tableColumns(db, 'twin_home_command_receipts')).toEqual([
      'execution_token', 'material_digest', 'provider', 'external_id', 'operation', 'request_json',
      'expected_state_json', 'provider_request_id', 'status', 'observed_event_id', 'result_json',
      'created_at', 'updated_at', 'verified_at',
    ])

    expect(indexSignature(db, 'twin_home_device_bindings', 'idx_twin_home_binding_provider_identity'))
      .toEqual({ unique: 1, columns: ['provider', 'external_id'] })
    expect(indexSignature(db, 'twin_home_provider_events', 'idx_twin_home_provider_event_identity'))
      .toEqual({ unique: 1, columns: ['provider', 'event_id'] })
    expect(indexSignature(db, 'twin_home_inventory_ledger', 'idx_twin_home_inventory_ledger_source'))
      .toEqual({ unique: 1, columns: ['source', 'source_id'] })
    expect(indexSignature(db, 'twin_home_device_states', 'idx_twin_home_device_states_observed'))
      .toEqual({ unique: 0, columns: ['observed_at', 'device_id'] })

    db.close()
  })

  it('enforces bounded JSON, exact provider identities, state shape, and receipt digests', async () => {
    const { initPersonalTwinSchema } = await import('../../packages/server/src/services/hermes/personal-twin')
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(db)

    expect(() => db.prepare(`INSERT INTO twin_home_spaces
      (space_id,kind,name,parent_space_id,attributes_json,version,created_at,updated_at)
      VALUES('space:bad','room','Bad',NULL,'[]',1,'now','now')`).run()).toThrow()
    db.prepare(`INSERT INTO twin_home_devices
      (device_id,name,device_class,space_id,availability,attributes_json,version,created_at,updated_at)
      VALUES(?,?,?,?,?,'{}',1,?,?)`).run('device:lamp', 'Lamp', 'light', null, 'available', 'now', 'now')
    const insertBinding = db.prepare(`INSERT INTO twin_home_device_bindings
      (binding_id,device_id,provider,external_id,capabilities_json,metadata_json,version,created_at,updated_at)
      VALUES(?,?,?,?,?,'{}',1,?,?)`)
    insertBinding.run('binding:lamp', 'device:lamp', 'home-assistant', 'light.lamp', '["power"]', 'now', 'now')
    expect(() => insertBinding.run(
      'binding:duplicate', 'device:lamp', 'home-assistant', 'light.lamp', '["power"]', 'now', 'now',
    )).toThrow()
    expect(() => db.prepare(`INSERT INTO twin_home_device_states
      (device_id,state_key,value_json,source_event_id,observed_at,received_at,version)
      VALUES('device:lamp','power','not-json','event:1','now','now',1)`).run()).toThrow()
    expect(() => db.prepare(`INSERT INTO twin_home_command_receipts
      (execution_token,material_digest,provider,external_id,operation,request_json,expected_state_json,
       provider_request_id,status,observed_event_id,result_json,created_at,updated_at,verified_at)
      VALUES('execution:1','bad','home-assistant','light.lamp','set_power','{}','{}',NULL,'prepared',NULL,NULL,'now','now',NULL)`)
      .run()).toThrow()

    db.close()
  })

  it('upgrades v10 atomically without losing existing twin rows and reopens idempotently', async () => {
    const { initPersonalTwinSchema } = await import('../../packages/server/src/services/hermes/personal-twin')
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(db)
    db.prepare(`INSERT INTO twin_entities
      (id,type,label,attributes_json,source,source_id,created_at,updated_at)
      VALUES('person:self','person','Self','{}','system','self','now','now')`).run()
    db.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE twin_home_command_receipts;
      DROP TABLE twin_home_device_states;
      DROP TABLE twin_home_device_bindings;
      DROP TABLE twin_home_provider_events;
      DROP TABLE twin_home_provider_cursors;
      DROP TABLE twin_home_inventory_ledger;
      DROP TABLE twin_home_inventory_items;
      DROP TABLE twin_home_devices;
      DROP TABLE twin_home_objects;
      DROP TABLE twin_home_spaces;
      UPDATE twin_meta SET value='10' WHERE key='schema_version';
      PRAGMA foreign_keys=ON;`)

    initPersonalTwinSchema(db)
    expect(db.prepare("SELECT id FROM twin_entities WHERE id='person:self'").get()).toEqual({ id: 'person:self' })
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '11' })
    expect(() => initPersonalTwinSchema(db)).not.toThrow()
    db.close()
  })

  it('fails closed when a v11 home table loses its check signature', async () => {
    const { initPersonalTwinSchema } = await import('../../packages/server/src/services/hermes/personal-twin')
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(db)
    db.exec(`DROP TABLE twin_home_provider_cursors;
      CREATE TABLE twin_home_provider_cursors (
        provider TEXT PRIMARY KEY, cursor_json TEXT NOT NULL DEFAULT '{}', connection_status TEXT NOT NULL,
        last_event_at TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL
      );`)

    expect(() => initPersonalTwinSchema(db)).toThrow(/home_provider_cursors.*check signature/i)
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '11' })
    db.close()
  })
})
