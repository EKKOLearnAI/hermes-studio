import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const TWIN_TABLES = [
  'twin_artifacts',
  'twin_constraints',
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
]

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
    hermesHome = ''
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
      const version = db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get() as {
        value: string
      }

      expect(names).toEqual(TWIN_TABLES)
      expect(version.value).toBe('1')
      expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    } finally {
      db.close()
    }
  })

  it('migrates an empty version-zero database once and remains reentrant', async () => {
    const { getPersonalTwinDbPath, withPersonalTwinDb } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    const path = getPersonalTwinDbPath()
    mkdirSync(dirname(path), { recursive: true })
    const seed = new DatabaseSync(path)
    try {
      seed.exec('CREATE TABLE twin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      seed.prepare("INSERT INTO twin_meta(key, value) VALUES('schema_version', '0')").run()
    } finally {
      seed.close()
    }

    withPersonalTwinDb(db => db.prepare('SELECT 1').get())
    withPersonalTwinDb(db => db.prepare('SELECT 1').get())

    const db = new DatabaseSync(path, { open: true, readOnly: true })
    try {
      const names = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'twin_%' ORDER BY name",
      ).all() as Array<{ name: string }>).map(row => row.name)
      const version = db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get() as {
        value: string
      }

      expect(names).toEqual(TWIN_TABLES)
      expect(version.value).toBe('1')
    } finally {
      db.close()
    }
  })

  it('rejects a database created by a newer schema version', async () => {
    const { getPersonalTwinDbPath, withPersonalTwinDb } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    const path = getPersonalTwinDbPath()
    mkdirSync(dirname(path), { recursive: true })
    const seed = new DatabaseSync(path)
    try {
      seed.exec('CREATE TABLE twin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      seed.prepare("INSERT INTO twin_meta(key, value) VALUES('schema_version', '2')").run()
    } finally {
      seed.close()
    }

    expect(() => withPersonalTwinDb(db => db.prepare('SELECT 1').get())).toThrow(
      /schema version 2 is newer than supported version 1/i,
    )
  })

  it('rejects a current-version database with an incomplete schema', async () => {
    const { getPersonalTwinDbPath, withPersonalTwinDb } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )
    const path = getPersonalTwinDbPath()
    mkdirSync(dirname(path), { recursive: true })
    const seed = new DatabaseSync(path)
    try {
      seed.exec('CREATE TABLE twin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      seed.prepare("INSERT INTO twin_meta(key, value) VALUES('schema_version', '1')").run()
    } finally {
      seed.close()
    }

    expect(() => withPersonalTwinDb(db => db.prepare('SELECT 1').get())).toThrow(
      /schema version 1 is incomplete/i,
    )
  })
})
