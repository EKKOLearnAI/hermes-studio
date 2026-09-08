import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isEkkoDevelopmentEnvironment, resolveEkkoDatabasePath, type EkkoDataPathOptions } from './memory/paths'

const DEFAULT_MIGRATION_BUSY_TIMEOUT_MS = 5_000
const DEFAULT_MIGRATION_MAX_ATTEMPTS = 3

export interface EkkoDatabaseMigration {
  component: string
  version: number
  migrate(database: DatabaseSync): void
}

export interface EkkoDatabaseOptions extends EkkoDataPathOptions {
  databasePath?: string
  migrationBusyTimeoutMs?: number
  migrationMaxAttempts?: number
}

export interface EkkoDatabaseRecoveryReport {
  backupPath: string
  recoveredTables: Array<{ table: string; rows: number }>
  skippedTables: Array<{ table: string; reason: string }>
}

export class EkkoDatabaseMigrationError extends Error {
  readonly cause: unknown
  readonly lockFailure: boolean

  constructor(
    readonly databasePath: string,
    readonly component: string,
    readonly version: number,
    readonly attempts: number,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Ekko database migration failed at ${component}@${version} after ${attempts} attempt(s): ${detail}`)
    this.name = 'EkkoDatabaseMigrationError'
    this.cause = cause
    this.lockFailure = isSqliteLockError(cause)
  }
}

export class EkkoDatabaseManager {
  readonly databasePath: string
  private readonly development: boolean
  private readonly migrationBusyTimeoutMs: number
  private readonly migrationMaxAttempts: number
  private database?: DatabaseSync

  constructor(options: EkkoDatabaseOptions = {}) {
    this.databasePath = options.databasePath || resolveEkkoDatabasePath(options)
    this.development = isEkkoDevelopmentEnvironment(options.env ?? process.env)
    this.migrationBusyTimeoutMs = boundedInteger(
      options.migrationBusyTimeoutMs,
      DEFAULT_MIGRATION_BUSY_TIMEOUT_MS,
      0,
      60_000,
    )
    this.migrationMaxAttempts = boundedInteger(
      options.migrationMaxAttempts,
      DEFAULT_MIGRATION_MAX_ATTEMPTS,
      1,
      10,
    )
  }

  get connection(): DatabaseSync {
    if (!this.database) {
      mkdirSync(dirname(this.databasePath), { recursive: true })
      this.database = new DatabaseSync(this.databasePath)
      if (this.development) {
        this.database.exec('PRAGMA journal_mode=DELETE')
      } else {
        this.database.exec('PRAGMA journal_mode=WAL')
        this.database.exec('PRAGMA synchronous=NORMAL')
        this.database.exec('PRAGMA foreign_keys=ON')
      }
      this.database.exec(`PRAGMA busy_timeout=${this.migrationBusyTimeoutMs}`)
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          component TEXT NOT NULL,
          version INTEGER NOT NULL,
          applied_at TEXT NOT NULL,
          PRIMARY KEY (component, version)
        )
      `)
    }
    return this.database
  }

  migrate(migrations: EkkoDatabaseMigration[]): void {
    const ordered = [...migrations].sort((left, right) => {
      if (left.component !== right.component) return left.component.localeCompare(right.component)
      return left.version - right.version
    })
    for (const migration of ordered) {
      let completed = false
      let lastError: unknown
      let attempts = 0
      for (let attempt = 1; attempt <= this.migrationMaxAttempts; attempt += 1) {
        attempts = attempt
        try {
          const applied = this.connection.prepare(
            'SELECT 1 FROM schema_migrations WHERE component = ? AND version = ?',
          ).get(migration.component, migration.version)
          if (!applied) {
            this.transaction(() => {
              migration.migrate(this.connection)
              this.connection.prepare(
                'INSERT INTO schema_migrations (component, version, applied_at) VALUES (?, ?, ?)',
              ).run(migration.component, migration.version, new Date().toISOString())
            })
          }
          completed = true
          break
        } catch (error) {
          lastError = error
          if (!isSqliteLockError(error)) break
        }
      }
      if (!completed) {
        throw new EkkoDatabaseMigrationError(
          this.databasePath,
          migration.component,
          migration.version,
          attempts,
          lastError,
        )
      }
    }
  }

  quarantineForRebuild(): string {
    this.close()
    if (!existsSync(this.databasePath)) {
      throw new Error(`Ekko database cannot be rebuilt because it does not exist: ${this.databasePath}`)
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.databasePath}.migration-failed-${timestamp}-${randomUUID()}.bak`
    renameDatabaseFamily(this.databasePath, backupPath)
    return backupPath
  }

  restoreQuarantinedDatabase(backupPath: string): string | undefined {
    this.close()
    let failedRebuildPath: string | undefined
    if (existsSync(this.databasePath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      failedRebuildPath = `${this.databasePath}.rebuild-failed-${timestamp}-${randomUUID()}.bak`
      renameDatabaseFamily(this.databasePath, failedRebuildPath)
    }
    try {
      renameDatabaseFamily(backupPath, this.databasePath)
    } catch (error) {
      if (failedRebuildPath && existsSync(failedRebuildPath) && !existsSync(this.databasePath)) {
        try {
          renameDatabaseFamily(failedRebuildPath, this.databasePath)
        } catch {
          // Preserve the original restore error and every backup file.
        }
      }
      throw error
    }
    return failedRebuildPath
  }

  recoverCompatibleTables(
    backupPath: string,
    tables: readonly string[],
  ): EkkoDatabaseRecoveryReport {
    const report: EkkoDatabaseRecoveryReport = {
      backupPath,
      recoveredTables: [],
      skippedTables: [],
    }
    const source = new DatabaseSync(backupPath, { readOnly: true })
    try {
      for (const table of tables) {
        const savepoint = `recover_${report.recoveredTables.length + report.skippedTables.length}`
        this.connection.exec(`SAVEPOINT ${savepoint}`)
        try {
          const sourceColumns = tableColumns(source, table)
          const targetColumns = tableColumns(this.connection, table)
          const columns = targetColumns.filter(column => sourceColumns.includes(column))
          if (!columns.length) throw new Error('no compatible columns')
          const sourceRows = source.prepare(
            `SELECT ${columns.map(quotedIdentifier).join(', ')} FROM ${quotedIdentifier(table)}`,
          ).iterate() as Iterable<Record<string, unknown>>
          const insert = this.connection.prepare(`
            INSERT OR IGNORE INTO ${quotedIdentifier(table)}
              (${columns.map(quotedIdentifier).join(', ')})
            VALUES (${columns.map(() => '?').join(', ')})
          `)
          let recoveredRows = 0
          for (const row of sourceRows) {
            recoveredRows += Number(insert.run(...columns.map(column => sqliteValue(row[column]))).changes)
          }
          this.connection.exec(`RELEASE SAVEPOINT ${savepoint}`)
          report.recoveredTables.push({ table, rows: recoveredRows })
        } catch (error) {
          try {
            this.connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
            this.connection.exec(`RELEASE SAVEPOINT ${savepoint}`)
          } catch {
            // Keep the first table recovery error.
          }
          report.skippedTables.push({
            table,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      source.close()
    }
    return report
  }

  transaction<T>(operation: () => T): T {
    const db = this.connection
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original transaction error.
      }
      throw error
    }
  }

  close(): void {
    if (!this.database) return
    try {
      this.database.close()
    } finally {
      this.database = undefined
    }
  }
}

function isSqliteLockError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | undefined
  const code = String(record?.code || '').toUpperCase()
  const message = String(record?.message || error || '').toLowerCase()
  return code.includes('SQLITE_BUSY')
    || code.includes('SQLITE_LOCKED')
    || message.includes('database is locked')
    || message.includes('database is busy')
    || message.includes('database table is locked')
}

function renameDatabaseFamily(sourcePath: string, targetPath: string): void {
  const moved: Array<{ source: string; target: string }> = []
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${sourcePath}${suffix}`
      if (!existsSync(source)) continue
      const target = `${targetPath}${suffix}`
      renameSync(source, target)
      moved.push({ source, target })
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      try {
        renameSync(item.target, item.source)
      } catch {
        // Preserve the original rename error and every recoverable file.
      }
    }
    throw error
  }
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  const exists = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table)
  if (!exists) throw new Error('table is missing')
  return (database.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all() as Array<{ name: string }>)
    .map(column => String(column.name))
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function sqliteValue(value: unknown): string | number | bigint | Uint8Array | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  throw new Error(`unsupported SQLite recovery value: ${typeof value}`)
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(Number(value))))
}
