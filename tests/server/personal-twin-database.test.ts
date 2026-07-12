import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('personal twin database', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-personal-twin-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('creates one global twin database below Hermes home', async () => {
    const { getPersonalTwinDbPath, withPersonalTwinDb } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )

    expect(getPersonalTwinDbPath()).toBe(join(hermesHome, 'personal', 'twin.db'))
    withPersonalTwinDb(db => db.prepare('SELECT 1').get())
    expect(existsSync(getPersonalTwinDbPath())).toBe(true)

    const db = new DatabaseSync(getPersonalTwinDbPath(), { open: true, readOnly: true })
    try {
      const names = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'twin_%' ORDER BY name",
      ).all() as Array<{ name: string }>).map(row => row.name)

      expect(names).toEqual([
        'twin_artifacts',
        'twin_assistant_roles',
        'twin_constraints',
        'twin_context_recipes',
        'twin_entities',
        'twin_events',
        'twin_goals',
        'twin_import_runs',
        'twin_meta',
        'twin_observations',
        'twin_outbox',
        'twin_preference_operations',
        'twin_preferences',
        'twin_projections',
        'twin_relations',
        'twin_role_profile_mappings',
      ])
      expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
      expect((db.prepare("PRAGMA table_info('twin_preferences')").all() as Array<{ name: string }>).map(row => row.name))
        .toEqual(expect.arrayContaining(['actor', 'version']))
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_twin_preference_operations_no_delete'").get())
        .toEqual({ name: 'trg_twin_preference_operations_no_delete' })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_twin_preferences_address'").get())
        .toEqual({ name: 'idx_twin_preferences_address' })
    } finally {
      db.close()
    }

    withPersonalTwinDb(db => db.prepare('SELECT 1').get())
  })

  it('upgrades an explicitly empty schema version zero database', async () => {
    const { getPersonalTwinDbPath, withPersonalTwinDb } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    const path = getPersonalTwinDbPath()
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE twin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO twin_meta(key, value) VALUES (?, ?)').run('schema_version', '0')
    db.close()

    withPersonalTwinDb(current => current.prepare('SELECT 1').get())

    const upgraded = new DatabaseSync(path, { readOnly: true })
    try {
      expect(upgraded.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'twin_entities'").get()).toEqual({ name: 'twin_entities' })
    } finally {
      upgraded.close()
    }
  })

  it('migrates an existing v1 database to role schema v2 without losing twin rows', async () => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    const path = getPersonalTwinDbPath()
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(path)
    initPersonalTwinSchema(db)
    db.prepare(`
      INSERT INTO twin_entities (
        id, type, label, attributes_json, source, source_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'person:self',
      'person',
      'Self',
      '{}',
      'system',
      'self',
      '2026-07-11T00:00:00.000Z',
      '2026-07-11T00:00:00.000Z',
    )
    db.prepare("UPDATE twin_meta SET value = '1' WHERE key = 'schema_version'").run()
    db.exec(`
      DROP TABLE IF EXISTS twin_context_recipes;
      DROP TABLE IF EXISTS twin_role_profile_mappings;
      DROP TABLE IF EXISTS twin_assistant_roles;
    `)

    initPersonalTwinSchema(db)

    try {
      expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
      expect(db.prepare("SELECT id FROM twin_entities WHERE id = 'person:self'").get()).toEqual({ id: 'person:self' })
      const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name))
      expect(names.has('twin_assistant_roles')).toBe(true)
      expect(names.has('twin_role_profile_mappings')).toBe(true)
      expect(names.has('twin_context_recipes')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('migrates v2 preferences to authoritative actor/version provenance without data loss', async () => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    const path = getPersonalTwinDbPath()
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(path)
    initPersonalTwinSchema(db)
    db.exec(`DROP TABLE twin_preference_operations; ALTER TABLE twin_preferences RENAME TO current_preferences;
      CREATE TABLE twin_preferences (
        id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
        confidence REAL NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source, source_id)
      );
      INSERT INTO twin_preferences(id,subject_id,key,value_json,confidence,source,source_id,created_at,updated_at)
        SELECT id,subject_id,key,value_json,confidence,source,source_id,created_at,updated_at FROM current_preferences;
      DROP TABLE current_preferences;
      UPDATE twin_meta SET value='2' WHERE key='schema_version';`)
    db.prepare(`INSERT INTO twin_preferences VALUES(?,?,?,?,?,?,?,?,?)`).run(
      'preference-legacy', 'person:self', 'calendar.view', '"agenda"', 0.7,
      'legacy-source', 'legacy-id', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
    )

    initPersonalTwinSchema(db)
    expect(db.prepare('SELECT id,key,actor,version,value_json,confidence,source,source_id,created_at,updated_at FROM twin_preferences WHERE id=?').get('preference-legacy'))
      .toEqual({ id: 'preference-legacy', key: 'life:calendar.view', actor: 'legacy-source', version: 1,
        value_json: '"agenda"', confidence: 0.7, source: 'legacy-source', source_id: 'legacy-id',
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-02T00:00:00.000Z' })
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '4' })
    expect(() => initPersonalTwinSchema(db)).not.toThrow()
    db.close()
  })

  it('migrates only unqualified legacy keys to life while preserving canonical addresses', async () => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.prepare(`INSERT INTO twin_entities(id,type,label,attributes_json,source,source_id,created_at,updated_at)
      VALUES('person:self','person','Self','{}','system','self','2026-07-01','2026-07-01')`).run()
    db.prepare("UPDATE twin_meta SET value='3' WHERE key='schema_version'").run()
    db.exec('DROP INDEX IF EXISTS idx_twin_preferences_address')
    const insert = db.prepare(`INSERT INTO twin_preferences
      (id,subject_id,key,value_json,confidence,source,source_id,actor,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    insert.run('legacy', 'person:self', 'calendar.view', '"agenda"', 0.7, 'legacy', 'legacy-1', 'importer', 4, 'created', 'updated')
    insert.run('canonical', 'person:self', 'digital:appearance.theme', '"dark"', 1, 'native', 'native-1', 'user', 2, 'created-2', 'updated-2')

    initPersonalTwinSchema(db)

    expect(db.prepare('SELECT id,key,value_json,source,source_id,actor,version,created_at,updated_at FROM twin_preferences ORDER BY id').all())
      .toEqual([
        { id: 'canonical', key: 'digital:appearance.theme', value_json: '"dark"', source: 'native', source_id: 'native-1', actor: 'user', version: 2, created_at: 'created-2', updated_at: 'updated-2' },
        { id: 'legacy', key: 'life:calendar.view', value_json: '"agenda"', source: 'legacy', source_id: 'legacy-1', actor: 'importer', version: 4, created_at: 'created', updated_at: 'updated' },
      ])
    db.close()
  })

  it.each([
    ['bad-domain', 'unknown:calendar.view'],
    ['empty-key', 'life:'],
    ['nested-colon', 'life:calendar:view'],
    ['reserved', 'life:_system.admin'],
    ['sensitive', 'life:api_token'],
    ['unicode', '日历'],
    ['too-long', 'x'.repeat(161)],
  ])('fails closed and rolls back v3 migration for %s preference keys', async (_case, key) => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.prepare(`INSERT INTO twin_entities(id,type,label,attributes_json,source,source_id,created_at,updated_at)
      VALUES('person:self','person','Self','{}','system','self','2026-07-01','2026-07-01')`).run()
    db.prepare("UPDATE twin_meta SET value='3' WHERE key='schema_version'").run()
    db.exec('DROP INDEX IF EXISTS idx_twin_preferences_address')
    db.prepare(`INSERT INTO twin_preferences
      (id,subject_id,key,value_json,confidence,source,source_id,actor,version,created_at,updated_at)
      VALUES('bad-record','person:self',?,'null',1,'legacy','bad-record','legacy',1,'created','updated')`).run(key)

    expect(() => initPersonalTwinSchema(db)).toThrow(/bad-record.*key/i)
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
    expect(db.prepare("SELECT key FROM twin_preferences WHERE id='bad-record'").get()).toEqual({ key })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_twin_preferences_address'").get()).toBeUndefined()
    db.close()
  })

  it('fails closed before migration when legacy and canonical keys collide for one subject', async () => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.prepare(`INSERT INTO twin_entities(id,type,label,attributes_json,source,source_id,created_at,updated_at)
      VALUES('person:self','person','Self','{}','system','self','2026-07-01','2026-07-01')`).run()
    db.prepare("UPDATE twin_meta SET value='3' WHERE key='schema_version'").run()
    db.exec('DROP INDEX IF EXISTS idx_twin_preferences_address')
    const insert = db.prepare(`INSERT INTO twin_preferences
      (id,subject_id,key,value_json,confidence,source,source_id,actor,version,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?,?,1,'created','updated')`)
    insert.run('legacy-row', 'person:self', 'calendar.view', '"agenda"', 'legacy', 'legacy-row', 'legacy')
    insert.run('canonical-row', 'person:self', 'life:calendar.view', '"month"', 'native', 'canonical-row', 'native')

    expect(() => initPersonalTwinSchema(db)).toThrow(/duplicate.*legacy-row.*canonical-row|duplicate.*canonical-row.*legacy-row/i)
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
    expect(db.prepare('SELECT id,key FROM twin_preferences ORDER BY id').all()).toEqual([
      { id: 'canonical-row', key: 'life:calendar.view' }, { id: 'legacy-row', key: 'calendar.view' },
    ])
    db.close()
  })

  it('enforces and verifies a unique subject preference address index', async () => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.prepare(`INSERT INTO twin_entities(id,type,label,attributes_json,source,source_id,created_at,updated_at)
      VALUES('person:self','person','Self','{}','system','self','2026-07-01','2026-07-01')`).run()
    const insert = db.prepare(`INSERT INTO twin_preferences
      (id,subject_id,key,value_json,confidence,source,source_id,actor,version,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?,?,1,'created','updated')`)
    insert.run('first', 'person:self', 'life:calendar.view', '"agenda"', 'source', 'first', 'actor')
    expect(() => insert.run('duplicate', 'person:self', 'life:calendar.view', '"month"', 'source', 'duplicate', 'actor'))
      .toThrow(/unique/i)
    insert.run('other', 'person:self', 'digital:appearance.theme', '"dark"', 'source', 'other', 'actor')
    expect(() => db.prepare("UPDATE twin_preferences SET key='life:calendar.view' WHERE id='other'").run()).toThrow(/unique/i)

    db.exec('DROP INDEX idx_twin_preferences_address; CREATE INDEX idx_twin_preferences_address ON twin_preferences(subject_id,key)')
    expect(() => initPersonalTwinSchema(db)).toThrow(/index.*signature|unique.*index/i)
    db.close()
  })

  it('rejects a database created by a future schema version', async () => {
    const { getPersonalTwinDbPath, withPersonalTwinDb } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    const path = getPersonalTwinDbPath()
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE twin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO twin_meta(key, value) VALUES (?, ?)').run('schema_version', '5')
    db.close()

    expect(() => withPersonalTwinDb(current => current.prepare('SELECT 1').get())).toThrow(/newer than supported version/i)
  })
})
