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
      expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '3' })
      expect((db.prepare("PRAGMA table_info('twin_preferences')").all() as Array<{ name: string }>).map(row => row.name))
        .toEqual(expect.arrayContaining(['actor', 'version']))
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_twin_preference_operations_no_delete'").get())
        .toEqual({ name: 'trg_twin_preference_operations_no_delete' })
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
      expect(upgraded.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '3' })
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
      expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '3' })
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
      'preference-legacy', 'person:self', 'life:calendar.view', '"agenda"', 0.7,
      'legacy-source', 'legacy-id', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
    )

    initPersonalTwinSchema(db)
    expect(db.prepare('SELECT actor,version,value_json FROM twin_preferences WHERE id=?').get('preference-legacy'))
      .toEqual({ actor: 'legacy-source', version: 1, value_json: '"agenda"' })
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
    expect(() => initPersonalTwinSchema(db)).not.toThrow()
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
    db.prepare('INSERT INTO twin_meta(key, value) VALUES (?, ?)').run('schema_version', '4')
    db.close()

    expect(() => withPersonalTwinDb(current => current.prepare('SELECT 1').get())).toThrow(/newer than supported version/i)
  })
})
