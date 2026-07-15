import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isEkkoDevelopmentEnvironment, resolveEkkoDatabasePath, type EkkoDataPathOptions } from './memory/paths'

export interface EkkoDatabaseMigration {
  component: string
  version: number
  migrate(database: DatabaseSync): void
}

export interface EkkoDatabaseOptions extends EkkoDataPathOptions {
  databasePath?: string
}

export class EkkoDatabaseManager {
  readonly databasePath: string
  private readonly development: boolean
  private database?: DatabaseSync

  constructor(options: EkkoDatabaseOptions = {}) {
    this.databasePath = options.databasePath || resolveEkkoDatabasePath(options)
    this.development = isEkkoDevelopmentEnvironment(options.env ?? process.env)
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
        this.database.exec('PRAGMA busy_timeout=5000')
        this.database.exec('PRAGMA foreign_keys=ON')
      }
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
      const applied = this.connection.prepare(
        'SELECT 1 FROM schema_migrations WHERE component = ? AND version = ?',
      ).get(migration.component, migration.version)
      if (applied) continue
      this.transaction(() => {
        migration.migrate(this.connection)
        this.connection.prepare(
          'INSERT INTO schema_migrations (component, version, applied_at) VALUES (?, ?, ?)',
        ).run(migration.component, migration.version, new Date().toISOString())
      })
    }
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
