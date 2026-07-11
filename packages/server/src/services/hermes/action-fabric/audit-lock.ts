import { existsSync, mkdirSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'

const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const MAX_BUSY_TIMEOUT_MS = 60_000

export interface FabricAuditWriterLockOptions {
  busyTimeoutMs?: number
}

export function getFabricAuditWriterLockPath(directory: string): string {
  const personalDirectory = resolve(directory)
  if (basename(personalDirectory) !== 'personal') {
    throw new Error('FABRIC_AUDIT_WRITER_LOCK_PATH_INVALID')
  }
  const lockPath = resolve(personalDirectory, '.action-fabric-audit-lock')
  if (dirname(lockPath) !== personalDirectory) {
    throw new Error('FABRIC_AUDIT_WRITER_LOCK_PATH_INVALID')
  }
  return lockPath
}

export function withFabricAuditWriterLock<T>(
  directory: string,
  operation: () => T,
  options: FabricAuditWriterLockOptions = {},
): T {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new Error('FABRIC_AUDIT_WRITER_LOCK_OPTIONS_INVALID')
  }

  const lockPath = getFabricAuditWriterLockPath(directory)
  mkdirSync(resolve(directory), { recursive: true })

  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(lockPath)
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    database.exec('PRAGMA journal_mode = DELETE')
    database.exec(`
      CREATE TABLE IF NOT EXISTS audit_writer_mutex (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      )
    `)
    database.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    try { database?.close() } catch { /* preserve the acquisition failure */ }
    if (isSqliteBusy(error)) throw new Error('FABRIC_AUDIT_WRITER_BUSY')
    throw new Error('FABRIC_AUDIT_WRITER_LOCK_UNAVAILABLE')
  }

  try {
    return operation()
  } finally {
    try {
      if (database.isTransaction) database.exec('ROLLBACK')
    } finally {
      database.close()
    }
  }
}

/** Shared cross-process serialization boundary for Action Fabric and policy-affecting Personal Twin writes. */
export function withPersonalActionFabricWriterLock<T>(operation: () => T): T {
  let home = process.env.HERMES_HOME ? resolve(process.env.HERMES_HOME) : resolve(homedir(), '.hermes')
  if (!process.env.HERMES_HOME && process.platform === 'win32') {
    const native = [process.env.LOCALAPPDATA, process.env.APPDATA]
      .filter((value): value is string => !!value?.trim()).map(value => resolve(value, 'hermes'))
      .find(existsSync)
    if (native) home = native
  }
  if (basename(dirname(home)) === 'profiles') home = dirname(dirname(home))
  return withFabricAuditWriterLock(join(home, 'personal'), operation)
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || /database is (?:busy|locked)/i.test(error.message)
}
