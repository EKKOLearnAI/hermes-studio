import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EkkoDatabaseManager,
  EkkoDirectoryManager,
  DEFAULT_EKKO_CONFIG,
  resolveEkkoDatabasePath,
  resolveEkkoDataDirectory,
  setupEkkoAgent,
} from '../../packages/ekko-agent/src'

let webUiHome = ''

beforeEach(async () => {
  webUiHome = await mkdtemp(join(tmpdir(), 'ekko-database-'))
})

afterEach(async () => {
  await rm(webUiHome, { recursive: true, force: true })
})

describe('EkkoDatabaseManager', () => {
  it('uses the Web UI Ekko directory and database name outside development', () => {
    const options = { baseDirectory: webUiHome, env: { NODE_ENV: 'production' } }
    expect(resolveEkkoDataDirectory(options)).toBe(join(webUiHome, '.ekko'))
    expect(resolveEkkoDatabasePath(options)).toBe(join(webUiHome, '.ekko', 'ekko.db'))
    expect(new EkkoDirectoryManager().baseDirectory).toBe(homedir())
  })

  it('uses the package-local SQL data directory in development', () => {
    const packageRoot = join(webUiHome, 'ekko-agent')
    const options = {
      baseDirectory: join(webUiHome, 'production-home'),
      env: { NODE_ENV: 'development' },
      packageRoot,
    }

    expect(resolveEkkoDataDirectory(options)).toBe(join(packageRoot, 'sql-data'))
    expect(resolveEkkoDatabasePath(options)).toBe(join(packageRoot, 'sql-data', 'ekko-agent.db'))
  })

  it('initializes the Ekko root with its global config, skills, and workspace directories', async () => {
    const directories = new EkkoDirectoryManager(webUiHome)
    expect(existsSync(directories.rootDirectory)).toBe(false)

    expect(directories.initialize()).toEqual({
      baseDirectory: webUiHome,
      rootDirectory: join(webUiHome, '.ekko'),
      databasePath: join(webUiHome, '.ekko', 'ekko.db'),
      configDirectory: join(webUiHome, '.ekko', 'config'),
      configPath: join(webUiHome, '.ekko', 'config', 'config.json'),
      skillsDirectory: join(webUiHome, '.ekko', 'skills'),
      logsDirectory: join(webUiHome, '.ekko', 'logs'),
      workspaceDirectory: join(webUiHome, '.ekko', 'workspace'),
    })
    expect(existsSync(directories.configDirectory)).toBe(true)
    await expect(readFile(directories.configPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(DEFAULT_EKKO_CONFIG, null, 2)}\n`,
    )
    expect(existsSync(directories.skillsDirectory)).toBe(true)
    expect(existsSync(directories.workspaceDirectory)).toBe(true)
    expect(existsSync(directories.logsDirectory)).toBe(false)
    expect(existsSync(directories.databasePath)).toBe(false)
    expect(directories.profileSkillsDirectory('work')).toBe(join(webUiHome, '.ekko', 'skills', 'work'))
    expect(directories.profileLogsDirectory('work')).toBe(join(webUiHome, '.ekko', 'logs', 'work'))
    expect(directories.profileWorkspaceDirectory('work')).toBe(join(webUiHome, '.ekko', 'workspace', 'work'))
    expect(directories.sessionWorkspaceDirectory('work', 'session-1')).toBe(
      join(webUiHome, '.ekko', 'workspace', 'work', 'session-1'),
    )
    expect(existsSync(join(webUiHome, '.ekko', 'skills', 'work'))).toBe(true)
    expect(existsSync(join(webUiHome, '.ekko', 'logs', 'work'))).toBe(true)
    expect(existsSync(join(webUiHome, '.ekko', 'workspace', 'work', 'session-1'))).toBe(true)
    expect(existsSync(join(webUiHome, '.ekko', 'skills', 'work', '.ekko-backups'))).toBe(false)
    expect(existsSync(join(webUiHome, '.ekko', 'skills', 'work', '.ekko-archive'))).toBe(false)
  })

  it('initializes the global config idempotently without creating profile config directories', async () => {
    const directories = new EkkoDirectoryManager(webUiHome)
    expect(directories.initializeConfigDirectory()).toBe(
      join(webUiHome, '.ekko', 'config', 'config.json'),
    )
    await writeFile(directories.configPath, '{\n  "custom": true\n}\n')

    directories.initialize()

    await expect(readFile(directories.configPath, 'utf8')).resolves.toBe(
      '{\n  "custom": true\n}\n',
    )
    expect(existsSync(join(directories.configDirectory, 'default'))).toBe(false)
  })

  it('sets up directories, profiles, config, and the migrated database before an agent run', async () => {
    const setup = setupEkkoAgent({
      baseDirectory: webUiHome,
      profiles: ['work'],
      env: { NODE_ENV: 'test' },
    })

    try {
      expect(existsSync(setup.layout.configPath)).toBe(true)
      expect(existsSync(setup.layout.databasePath)).toBe(true)
      expect(existsSync(join(setup.layout.skillsDirectory, 'default'))).toBe(true)
      expect(existsSync(join(setup.layout.skillsDirectory, 'work'))).toBe(true)
      expect(existsSync(join(setup.layout.logsDirectory, 'default'))).toBe(true)
      expect(existsSync(join(setup.layout.logsDirectory, 'work'))).toBe(true)
      expect(existsSync(join(setup.layout.workspaceDirectory, 'default'))).toBe(true)
      expect(existsSync(join(setup.layout.workspaceDirectory, 'work'))).toBe(true)
      expect(setup.memory.isEnabled).toBe(true)
      expect(setup.database.connection.prepare(
        'SELECT component, version FROM schema_migrations WHERE component = ?',
      ).get('memory')).toMatchObject({ component: 'memory', version: 3 })
    } finally {
      setup.close()
    }
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

  it('uses the package-local database path with development SQLite settings', () => {
    const packageRoot = join(webUiHome, 'ekko-agent')
    const options = {
      baseDirectory: join(webUiHome, 'production-home'),
      env: { NODE_ENV: 'development' },
      packageRoot,
    }
    const manager = new EkkoDatabaseManager(options)
    expect(manager.connection.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' })
    expect(manager.databasePath).toBe(join(packageRoot, 'sql-data', 'ekko-agent.db'))
    expect(existsSync(join(packageRoot, 'sql-data', 'ekko-agent.db'))).toBe(true)
    expect(existsSync(join(webUiHome, 'production-home', '.ekko', 'ekko.db'))).toBe(false)
    manager.close()
  })

  it('reports and opens the package-local database path during development setup', () => {
    const packageRoot = join(webUiHome, 'ekko-agent')
    const setup = setupEkkoAgent({
      baseDirectory: join(webUiHome, 'production-home'),
      env: { NODE_ENV: 'development' },
      packageRoot,
    })

    try {
      expect(setup.layout.databasePath).toBe(join(packageRoot, 'sql-data', 'ekko-agent.db'))
      expect(setup.database.databasePath).toBe(setup.layout.databasePath)
      expect(existsSync(setup.layout.databasePath)).toBe(true)
      expect(existsSync(join(webUiHome, 'production-home', '.ekko', 'ekko.db'))).toBe(false)
    } finally {
      setup.close()
    }
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
