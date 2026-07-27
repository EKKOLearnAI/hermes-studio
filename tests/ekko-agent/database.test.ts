import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EkkoDatabaseManager,
  EkkoDirectoryManager,
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
    expect(resolveEkkoDataDirectory({ baseDirectory: webUiHome })).toBe(join(webUiHome, '.ekko'))
    expect(resolveEkkoDatabasePath({ baseDirectory: webUiHome })).toBe(join(webUiHome, '.ekko', 'ekko.db'))
    expect(new EkkoDirectoryManager().baseDirectory).toBe(homedir())
  })

  it('initializes the Ekko root and only its skills feature directory', () => {
    const directories = new EkkoDirectoryManager(webUiHome)
    expect(existsSync(directories.rootDirectory)).toBe(false)

    expect(directories.initialize()).toEqual({
      baseDirectory: webUiHome,
      rootDirectory: join(webUiHome, '.ekko'),
      databasePath: join(webUiHome, '.ekko', 'ekko.db'),
      skillsDirectory: join(webUiHome, '.ekko', 'skills'),
      logsDirectory: join(webUiHome, '.ekko', 'logs'),
    })
    expect(existsSync(directories.skillsDirectory)).toBe(true)
    expect(existsSync(directories.logsDirectory)).toBe(false)
    expect(existsSync(directories.databasePath)).toBe(false)
    expect(directories.profileSkillsDirectory('work')).toBe(join(webUiHome, '.ekko', 'skills', 'work'))
    expect(directories.profileLogsDirectory('work')).toBe(join(webUiHome, '.ekko', 'logs', 'work'))
    expect(existsSync(join(webUiHome, '.ekko', 'skills', 'work'))).toBe(true)
    expect(existsSync(join(webUiHome, '.ekko', 'logs', 'work'))).toBe(true)
    expect(existsSync(join(webUiHome, '.ekko', 'skills', 'work', '.ekko-backups'))).toBe(false)
    expect(existsSync(join(webUiHome, '.ekko', 'skills', 'work', '.ekko-archive'))).toBe(false)
  })

  it('imports every Hermes profile skill only when the Ekko skills directory is first created', async () => {
    const hermesRoot = join(webUiHome, 'hermes')
    const ekkoBase = join(webUiHome, 'web-ui')
    await mkdir(join(hermesRoot, 'skills', 'default-skill'), { recursive: true })
    await mkdir(join(hermesRoot, 'profiles', 'work', 'skills', 'work-skill', 'references'), { recursive: true })
    await writeFile(join(hermesRoot, 'skills', 'default-skill', 'SKILL.md'), '# Default\nOriginal.\n')
    await writeFile(join(hermesRoot, 'profiles', 'work', 'skills', 'work-skill', 'SKILL.md'), '# Work\nProfile skill.\n')
    await writeFile(
      join(hermesRoot, 'profiles', 'work', 'skills', 'work-skill', 'references', 'guide.md'),
      'Imported support file.\n',
    )

    const directories = new EkkoDirectoryManager(ekkoBase)
    directories.initialize({ hermesRootDirectory: hermesRoot })

    await expect(readFile(
      join(ekkoBase, '.ekko', 'skills', 'default', 'default-skill', 'SKILL.md'),
      'utf8',
    )).resolves.toBe('# Default\nOriginal.\n')
    await expect(readFile(
      join(ekkoBase, '.ekko', 'skills', 'work', 'work-skill', 'references', 'guide.md'),
      'utf8',
    )).resolves.toBe('Imported support file.\n')

    await writeFile(join(hermesRoot, 'skills', 'default-skill', 'SKILL.md'), '# Default\nChanged later.\n')
    await mkdir(join(hermesRoot, 'skills', 'late-skill'), { recursive: true })
    await writeFile(join(hermesRoot, 'skills', 'late-skill', 'SKILL.md'), '# Late\nDo not import.\n')
    directories.initialize({ hermesRootDirectory: hermesRoot })

    await expect(readFile(
      join(ekkoBase, '.ekko', 'skills', 'default', 'default-skill', 'SKILL.md'),
      'utf8',
    )).resolves.toBe('# Default\nOriginal.\n')
    expect(existsSync(join(ekkoBase, '.ekko', 'skills', 'default', 'late-skill'))).toBe(false)
  })

  it('uses the same .ekko database path with development SQLite settings', () => {
    const options = { baseDirectory: webUiHome, env: { NODE_ENV: 'development' } }
    const manager = new EkkoDatabaseManager(options)
    expect(manager.connection.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' })
    expect(existsSync(join(webUiHome, '.ekko', 'ekko.db'))).toBe(true)
    manager.close()
  })

  it('owns the connection and component migrations', () => {
    const manager = new EkkoDatabaseManager({ baseDirectory: webUiHome })
    manager.migrate([{
      component: 'test-component',
      version: 1,
      migrate(database) {
        database.exec('CREATE TABLE test_records (id TEXT PRIMARY KEY)')
      },
    }])

    expect(existsSync(join(webUiHome, '.ekko', 'ekko.db'))).toBe(true)
    expect(manager.connection.prepare(
      'SELECT component, version FROM schema_migrations WHERE component = ?',
    ).get('test-component')).toMatchObject({ component: 'test-component', version: 1 })
    manager.close()
  })

  it('rolls back failed transactions', () => {
    const manager = new EkkoDatabaseManager({ baseDirectory: webUiHome })
    manager.connection.exec('CREATE TABLE transaction_test (value TEXT)')

    expect(() => manager.transaction(() => {
      manager.connection.prepare('INSERT INTO transaction_test (value) VALUES (?)').run('temporary')
      throw new Error('rollback')
    })).toThrow('rollback')

    expect(manager.connection.prepare('SELECT value FROM transaction_test').all()).toEqual([])
    manager.close()
  })
})
