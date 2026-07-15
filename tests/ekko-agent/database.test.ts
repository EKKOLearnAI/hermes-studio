import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EkkoDatabaseManager,
  resolveEkkoDatabasePath,
  resolveEkkoDataDirectory,
} from '../../packages/ekko-agent/src'

let webUiHome = ''

beforeEach(async () => {
  webUiHome = await mkdtemp(join(tmpdir(), 'ekko-database-'))
})

afterEach(async () => {
  await rm(webUiHome, { recursive: true, force: true })
})

describe('EkkoDatabaseManager', () => {
  it('uses the generic Ekko data directory and database name', () => {
    const env = { NODE_ENV: 'test' }
    expect(resolveEkkoDataDirectory({ webUiHome, env })).toBe(join(webUiHome, 'ekko'))
    expect(resolveEkkoDatabasePath({ webUiHome, env })).toBe(join(webUiHome, 'ekko', 'ekko.db'))
  })

  it('uses a Navicat-compatible package-local SQLite file in development', () => {
    const packageRoot = join(webUiHome, 'packages', 'ekko-agent')
    const options = { packageRoot, env: { NODE_ENV: 'development' } }
    expect(resolveEkkoDataDirectory(options)).toBe(join(packageRoot, 'sql-data'))
    expect(resolveEkkoDatabasePath(options)).toBe(join(packageRoot, 'sql-data', 'ekko-agent.db'))

    const manager = new EkkoDatabaseManager(options)
    expect(manager.connection.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' })
    expect(existsSync(join(packageRoot, 'sql-data', 'ekko-agent.db'))).toBe(true)
    manager.close()
  })

  it('owns the connection and component migrations', () => {
    const manager = new EkkoDatabaseManager({ webUiHome })
    manager.migrate([{
      component: 'test-component',
      version: 1,
      migrate(database) {
        database.exec('CREATE TABLE test_records (id TEXT PRIMARY KEY)')
      },
    }])

    expect(existsSync(join(webUiHome, 'ekko', 'ekko.db'))).toBe(true)
    expect(manager.connection.prepare(
      'SELECT component, version FROM schema_migrations WHERE component = ?',
    ).get('test-component')).toMatchObject({ component: 'test-component', version: 1 })
    manager.close()
  })

  it('rolls back failed transactions', () => {
    const manager = new EkkoDatabaseManager({ webUiHome })
    manager.connection.exec('CREATE TABLE transaction_test (value TEXT)')

    expect(() => manager.transaction(() => {
      manager.connection.prepare('INSERT INTO transaction_test (value) VALUES (?)').run('temporary')
      throw new Error('rollback')
    })).toThrow('rollback')

    expect(manager.connection.prepare('SELECT value FROM transaction_test').all()).toEqual([])
    manager.close()
  })
})
