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
        'twin_artifact_consents',
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
      expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '5' })
      expect((db.prepare("PRAGMA table_info('twin_artifacts')").all() as Array<{ name: string }>).map(row => row.name))
        .toEqual(['id', 'media_type', 'content_hash', 'relative_path', 'size_bytes', 'source', 'source_id', 'created_at', 'sensitivity', 'metadata_json'])
      expect((db.prepare("PRAGMA table_info('twin_artifact_consents')").all() as Array<{ name: string }>).map(row => row.name))
        .toEqual(['manifest_digest', 'processor', 'scope_json', 'issued_at', 'expires_at', 'consumed_at', 'revoked_at'])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_twin_artifacts_source_identity'").get())
        .toEqual({ name: 'idx_twin_artifacts_source_identity' })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_twin_artifact_consents_status'").get())
        .toEqual({ name: 'idx_twin_artifact_consents_status' })
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
      expect(upgraded.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '5' })
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
      expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '5' })
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
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '5' })
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

    let migrationError = ''
    try { initPersonalTwinSchema(db) } catch (error) { migrationError = String(error) }
    expect(migrationError).toMatch(/TWIN_PREFERENCE_LEGACY_KEY_INVALID.*record-[a-f0-9]{16}/)
    expect(migrationError).not.toContain('bad-record')
    expect(migrationError).not.toContain(key)
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
    expect(db.prepare("SELECT key FROM twin_preferences WHERE id='bad-record'").get()).toEqual({ key })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_twin_preferences_address'").get()).toBeUndefined()
    db.close()
  })

  it.each([
    'password=hunter2-from-trigger',
    'TWIN_PREFERENCE_LEGACY_KEY_INVALID token.sk_live_spoofed',
  ])('redacts unexpected database errors raised while migrating legacy preferences: %s', async triggerError => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.prepare(`INSERT INTO twin_entities(id,type,label,attributes_json,source,source_id,created_at,updated_at)
      VALUES('person:self','person','Self','{}','system','self','2026-07-01','2026-07-01')`).run()
    db.exec(`DROP INDEX idx_twin_preferences_address;
      UPDATE twin_meta SET value='3' WHERE key='schema_version';
      CREATE TRIGGER hostile_migration_error BEFORE UPDATE OF key ON twin_preferences
      BEGIN SELECT RAISE(ABORT, '${triggerError}'); END;`)
    db.prepare(`INSERT INTO twin_preferences
      (id,subject_id,key,value_json,confidence,source,source_id,actor,version,created_at,updated_at)
      VALUES('safe-id','person:self','calendar.view','null',1,'legacy','safe-source-id','legacy',1,'created','updated')`).run()

    let captured = ''
    try { initPersonalTwinSchema(db) } catch (error) { captured = String(error) }
    expect(captured).toContain('TWIN_PREFERENCE_MIGRATION_FAILED')
    expect(captured).not.toContain(triggerError)
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
    expect(db.prepare("SELECT key FROM twin_preferences WHERE id='safe-id'").get()).toEqual({ key: 'calendar.view' })
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

    let migrationError = ''
    try { initPersonalTwinSchema(db) } catch (error) { migrationError = String(error) }
    expect(migrationError).toMatch(/TWIN_PREFERENCE_LEGACY_KEY_COLLISION.*record-[a-f0-9]{16}.*record-[a-f0-9]{16}/)
    expect(migrationError).not.toContain('legacy-row')
    expect(migrationError).not.toContain('canonical-row')
    expect(migrationError).not.toContain('calendar.view')
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
    expect(db.prepare('SELECT id,key FROM twin_preferences ORDER BY id').all()).toEqual([
      { id: 'canonical-row', key: 'life:calendar.view' }, { id: 'legacy-row', key: 'calendar.view' },
    ])
    db.close()
  })

  it.each([
    'token.sk_live_SUPERSECRET987',
    'password=hunter2-material',
    'C:\\Users\\Alice\\credential.txt',
    '\\\\server\\share\\private-key.pem',
  ])('redacts hostile legacy key and record id material from migration errors: %s', async key => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.prepare(`INSERT INTO twin_entities(id,type,label,attributes_json,source,source_id,created_at,updated_at)
      VALUES('person:self','person','Self','{}','system','self','2026-07-01','2026-07-01')`).run()
    db.exec("DROP INDEX idx_twin_preferences_address; UPDATE twin_meta SET value='3' WHERE key='schema_version'")
    const hostileId = `credential://${key}/record`
    db.prepare(`INSERT INTO twin_preferences
      (id,subject_id,key,value_json,confidence,source,source_id,actor,version,created_at,updated_at)
      VALUES(?,'person:self',?,'null',1,'legacy','safe-source-id','legacy',1,'created','updated')`).run(hostileId, key)

    let captured = ''
    try { initPersonalTwinSchema(db) } catch (error) {
      const actual = error as Error
      captured = `${String(actual)}\n${actual.stack ?? ''}`
    }
    expect(captured).toMatch(/TWIN_PREFERENCE_LEGACY_KEY_INVALID.*record-[a-f0-9]{16}/)
    expect(captured).not.toContain(key)
    expect(captured).not.toContain(hostileId)
    expect(captured).not.toMatch(/SUPERSECRET987|hunter2-material|Users\\Alice|server\\share/)
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
    expect(db.prepare('SELECT id,key FROM twin_preferences').get()).toEqual({ id: hostileId, key })
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

  it('migrates v4 artifacts to v5 metadata and consent schema without data loss', async () => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.exec(`
      DROP TABLE twin_artifact_consents;
      DROP INDEX idx_twin_artifacts_source_identity;
      ALTER TABLE twin_artifacts RENAME TO twin_artifacts_v5;
      CREATE TABLE twin_artifacts (
        id TEXT PRIMARY KEY, media_type TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO twin_artifacts(id,media_type,content_hash,relative_path,size_bytes,source,source_id,created_at)
        SELECT id,media_type,content_hash,relative_path,size_bytes,source,source_id,created_at FROM twin_artifacts_v5;
      DROP TABLE twin_artifacts_v5;
      UPDATE twin_meta SET value='4' WHERE key='schema_version';
    `)
    db.prepare(`INSERT INTO twin_artifacts VALUES(?,?,?,?,?,?,?,?)`).run(
      'artifact-legacy', 'application/pdf', 'a'.repeat(64), 'health/reports/legacy.pdf', 42,
      'legacy-import', 'report-1', '2026-07-01T00:00:00.000Z',
    )

    initPersonalTwinSchema(db)

    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '5' })
    expect(db.prepare(`SELECT id,media_type,content_hash,relative_path,size_bytes,source,source_id,created_at,
      sensitivity,metadata_json FROM twin_artifacts WHERE id='artifact-legacy'`).get()).toEqual({
      id: 'artifact-legacy', media_type: 'application/pdf', content_hash: 'a'.repeat(64),
      relative_path: 'health/reports/legacy.pdf', size_bytes: 42, source: 'legacy-import', source_id: 'report-1',
      created_at: '2026-07-01T00:00:00.000Z', sensitivity: 'general', metadata_json: '{}',
    })
    expect(() => db.prepare(`INSERT INTO twin_artifacts
      (id,media_type,content_hash,relative_path,size_bytes,source,source_id,created_at,sensitivity,metadata_json)
      VALUES('artifact-other','application/pdf',?,'other.pdf',42,'legacy-import','report-1','2026-07-02','general','{}')`).run('b'.repeat(64)))
      .toThrow(/unique/i)
    expect((db.prepare("PRAGMA index_info('idx_twin_artifact_consents_status')").all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno).map(column => column.name))
      .toEqual(['processor', 'expires_at', 'consumed_at', 'revoked_at'])
    db.close()
  })

  it('fails closed when an asserted v5 artifact index signature is incomplete', async () => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.exec(`DROP INDEX idx_twin_artifacts_source_identity;
      CREATE INDEX idx_twin_artifacts_source_identity ON twin_artifacts(source)`)

    expect(() => initPersonalTwinSchema(db)).toThrow(/artifact.*index.*signature|index.*signature.*artifact/i)
    expect(db.prepare("SELECT value FROM twin_meta WHERE key='schema_version'").get()).toEqual({ value: '5' })
    db.close()
  })

  it('fails closed when asserted v5 consent column constraints are incomplete', async () => {
    const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getPersonalTwinDbPath())
    initPersonalTwinSchema(db)
    db.exec(`
      DROP TABLE twin_artifact_consents;
      CREATE TABLE twin_artifact_consents (
        manifest_digest TEXT PRIMARY KEY, processor TEXT, scope_json TEXT NOT NULL,
        issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT
      );
      CREATE INDEX idx_twin_artifact_consents_status
        ON twin_artifact_consents(processor, expires_at, consumed_at, revoked_at);
    `)

    expect(() => initPersonalTwinSchema(db)).toThrow(/artifact_consents.*signature|consent.*signature/i)
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
    db.prepare('INSERT INTO twin_meta(key, value) VALUES (?, ?)').run('schema_version', '6')
    db.close()

    expect(() => withPersonalTwinDb(current => current.prepare('SELECT 1').get())).toThrow(/newer than supported version/i)
  })
})
