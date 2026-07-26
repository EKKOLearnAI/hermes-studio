import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

type HermesDatabaseOwnership = {
  kind: 'process' | 'test'
  storagePath: string
  claimedAt: number
}

const hermesOwnedDatabases = new WeakMap<DatabaseSync, HermesDatabaseOwnership>()
const isTestRuntime = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'

function sqliteMainDatabasePath(db: DatabaseSync): string {
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>
  const main = rows.find((row) => row.name === 'main')
  return String(main?.file || '')
}

function isInMemorySqlitePath(path: string): boolean {
  return path === ''
    || path === ':memory:'
    || path.startsWith('file::memory:')
    || path.includes('mode=memory')
}

function canonicalFilePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function acquireHermesDatabaseOwnership(db: DatabaseSync, storagePath: string): void {
  const actualPath = sqliteMainDatabasePath(db)
  if (isInMemorySqlitePath(actualPath) || isInMemorySqlitePath(storagePath)) {
    throw new Error('In-memory Hermes databases must use the test-only ownership claim')
  }
  if (canonicalFilePath(actualPath) !== canonicalFilePath(storagePath)) {
    throw new Error(`Hermes database ownership path mismatch: opened ${actualPath}, expected ${storagePath}`)
  }

  db.exec('PRAGMA busy_timeout=1000')
  db.prepare('PRAGMA locking_mode=EXCLUSIVE').get()
  db.exec('BEGIN IMMEDIATE')
  db.exec('COMMIT')
  hermesOwnedDatabases.set(db, {
    kind: 'process',
    storagePath: actualPath,
    claimedAt: Date.now(),
  })
}

export function claimHermesDatabaseOwnershipForTesting(db: DatabaseSync): void {
  if (!isTestRuntime) {
    throw new Error('Hermes test database ownership may only be claimed during test runtime')
  }
  const storagePath = sqliteMainDatabasePath(db)
  if (!isInMemorySqlitePath(storagePath)) {
    throw new Error(`Hermes test database ownership only supports in-memory SQLite handles, received ${storagePath}`)
  }
  hermesOwnedDatabases.set(db, {
    kind: 'test',
    storagePath: storagePath || ':memory:',
    claimedAt: Date.now(),
  })
}

export function assertHermesDatabaseOwnership(db: DatabaseSync): void {
  if (hermesOwnedDatabases.has(db)) return
  throw new Error('Hermes database ownership is required before schema initialization or migration')
}

export function releaseHermesDatabaseOwnership(db: DatabaseSync): void {
  hermesOwnedDatabases.delete(db)
}
