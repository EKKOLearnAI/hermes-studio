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
        'twin_preferences',
        'twin_projections',
        'twin_relations',
        'twin_role_profile_mappings',
      ])
      expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '2' })
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
      expect(upgraded.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '2' })
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
      expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '2' })
      expect(db.prepare("SELECT id FROM twin_entities WHERE id = 'person:self'").get()).toEqual({ id: 'person:self' })
      const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name))
      expect(names.has('twin_assistant_roles')).toBe(true)
      expect(names.has('twin_role_profile_mappings')).toBe(true)
      expect(names.has('twin_context_recipes')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('rejects a database created by a future schema version', async () => {
    const { getPersonalTwinDbPath, withPersonalTwinDb } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    const path = getPersonalTwinDbPath()
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE twin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO twin_meta(key, value) VALUES (?, ?)').run('schema_version', '3')
    db.close()

    expect(() => withPersonalTwinDb(current => current.prepare('SELECT 1').get())).toThrow(/newer than supported version/i)
  })
})
