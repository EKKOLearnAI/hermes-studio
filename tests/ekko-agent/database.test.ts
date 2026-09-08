import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EkkoDatabaseManager,
  EkkoDatabaseMigrationError,
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

  it('uses the package-local Ekko directory in development', () => {
    const packageRoot = join(webUiHome, 'ekko-agent')
    const options = {
      baseDirectory: join(webUiHome, 'production-home'),
      env: { NODE_ENV: 'development' },
      packageRoot,
    }

    expect(resolveEkkoDataDirectory(options)).toBe(join(packageRoot, '.ekko'))
    expect(resolveEkkoDatabasePath(options)).toBe(join(packageRoot, '.ekko', 'ekko.db'))
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
        'SELECT component, max(version) AS version FROM schema_migrations WHERE component = ? GROUP BY component',
      ).get('memory')).toMatchObject({ component: 'memory', version: 8 })
    } finally {
      setup.close()
    }
  })

  it('resets the complete legacy skills directory once and reinstalls built-in skills', async () => {
    const hermesRoot = join(webUiHome, 'hermes')
    const ekkoBase = join(webUiHome, 'web-ui')
    const directories = new EkkoDirectoryManager(ekkoBase)
    directories.initialize()
    const defaultProfile = directories.profileSkillsDirectory('default')
    const workProfile = directories.profileSkillsDirectory('work')
    await mkdir(join(defaultProfile, 'web-access', '.git'), { recursive: true })
    await mkdir(join(workProfile, 'custom-skill'), { recursive: true })
    await writeFile(join(defaultProfile, 'web-access', 'SKILL.md'), '# Web access\n')
    const gitHead = join(defaultProfile, 'web-access', '.git', 'HEAD')
    await writeFile(gitHead, 'ref: refs/heads/main\n')
    await chmod(gitHead, 0o444)
    await writeFile(join(workProfile, 'custom-skill', 'SKILL.md'), '# Custom skill\n')

    directories.initialize({ hermesRootDirectory: hermesRoot })

    expect(existsSync(join(defaultProfile, 'web-access'))).toBe(false)
    expect(existsSync(join(workProfile, 'custom-skill'))).toBe(false)
    expect(existsSync(join(defaultProfile, 'weather', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(workProfile, 'weather', 'SKILL.md'))).toBe(true)
    await expect(readFile(
      join(ekkoBase, '.ekko', '.ekko-hermes-skill-cleanup-v2.json'),
      'utf8',
    ).then(JSON.parse)).resolves.toMatchObject({
      version: 2,
      hermesRootDirectory: hermesRoot,
      resetSkillsDirectory: true,
    })

    await mkdir(join(defaultProfile, 'created-after-reset'), { recursive: true })
    await writeFile(join(defaultProfile, 'created-after-reset', 'SKILL.md'), '# Keep me\n')
    directories.initialize({ hermesRootDirectory: hermesRoot })
    await expect(readFile(join(defaultProfile, 'created-after-reset', 'SKILL.md'), 'utf8'))
      .resolves.toBe('# Keep me\n')
  })

  it('installs only Ekko built-ins when the skills root does not exist', async () => {
    const hermesRoot = join(webUiHome, 'hermes')
    const ekkoBase = join(webUiHome, 'web-ui')
    await mkdir(join(hermesRoot, 'skills', 'hermes-only'), { recursive: true })
    await writeFile(join(hermesRoot, 'skills', 'hermes-only', 'SKILL.md'), '# Hermes only\n')

    const directories = new EkkoDirectoryManager(ekkoBase)
    directories.initialize({ hermesRootDirectory: hermesRoot })
    const profileDirectory = directories.profileSkillsDirectory('default')

    expect(existsSync(join(profileDirectory, 'hermes-only'))).toBe(false)
    expect(existsSync(join(profileDirectory, 'weather', 'SKILL.md'))).toBe(true)
    directories.initialize({ hermesRootDirectory: hermesRoot })
    expect(existsSync(join(profileDirectory, 'weather', 'SKILL.md'))).toBe(true)
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
    expect(manager.databasePath).toBe(join(packageRoot, '.ekko', 'ekko.db'))
    expect(existsSync(join(packageRoot, '.ekko', 'ekko.db'))).toBe(true)
    expect(existsSync(join(webUiHome, 'production-home', '.ekko', 'ekko.db'))).toBe(false)
    manager.close()
    expect(existsSync(join(packageRoot, '.ekko', 'ekko.db-wal'))).toBe(false)
    expect(existsSync(join(packageRoot, '.ekko', 'ekko.db-shm'))).toBe(false)
  })

  it('keeps every development artifact in the package-local Ekko directory', () => {
    const packageRoot = join(webUiHome, 'ekko-agent')
    const setup = setupEkkoAgent({
      baseDirectory: join(webUiHome, 'production-home'),
      env: { NODE_ENV: 'development' },
      packageRoot,
    })

    try {
      expect(setup.layout.rootDirectory).toBe(join(packageRoot, '.ekko'))
      expect(setup.layout.configPath).toBe(join(packageRoot, '.ekko', 'config', 'config.json'))
      expect(setup.layout.skillsDirectory).toBe(join(packageRoot, '.ekko', 'skills'))
      expect(setup.layout.logsDirectory).toBe(join(packageRoot, '.ekko', 'logs'))
      expect(setup.layout.workspaceDirectory).toBe(join(packageRoot, '.ekko', 'workspace'))
      expect(setup.layout.databasePath).toBe(join(packageRoot, '.ekko', 'ekko.db'))
      expect(setup.database.databasePath).toBe(setup.layout.databasePath)
      expect(existsSync(setup.layout.databasePath)).toBe(true)
      expect(existsSync(join(webUiHome, 'production-home', '.ekko', 'ekko.db'))).toBe(false)
      expect(existsSync(join(webUiHome, 'production-home', '.ekko', 'config', 'config.json'))).toBe(false)
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

  it('retries transient SQLite lock failures without rebuilding or duplicating writes', () => {
    const manager = new EkkoDatabaseManager({
      baseDirectory: webUiHome,
      migrationBusyTimeoutMs: 0,
      migrationMaxAttempts: 3,
    })
    let attempts = 0

    manager.migrate([{
      component: 'retry-component',
      version: 1,
      migrate(database) {
        attempts += 1
        database.exec('CREATE TABLE retry_records (value TEXT)')
        database.prepare('INSERT INTO retry_records (value) VALUES (?)').run(`attempt-${attempts}`)
        if (attempts < 3) throw new Error('database is locked')
      },
    }])

    expect(attempts).toBe(3)
    expect(manager.connection.prepare('SELECT value FROM retry_records').all())
      .toEqual([{ value: 'attempt-3' }])
    expect(manager.connection.prepare(
      'SELECT 1 AS applied FROM schema_migrations WHERE component = ? AND version = ?',
    ).get('retry-component', 1)).toMatchObject({ applied: 1 })
    manager.close()
  })

  it('wraps non-lock migration failures after rolling back the attempted schema change', () => {
    const manager = new EkkoDatabaseManager({ baseDirectory: webUiHome })

    expect(() => manager.migrate([{
      component: 'broken-component',
      version: 1,
      migrate(database) {
        database.exec('CREATE TABLE should_rollback (value TEXT)')
        throw new Error('invalid legacy schema')
      },
    }])).toThrow(EkkoDatabaseMigrationError)

    expect(manager.connection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
    ).get()).toBeUndefined()
    expect(manager.connection.prepare(
      'SELECT 1 FROM schema_migrations WHERE component = ? AND version = ?',
    ).get('broken-component', 1)).toBeUndefined()
    manager.close()
  })

  it('rebuilds after a non-lock migration failure and recovers memory plus conversations', async () => {
    const initial = setupEkkoAgent({ baseDirectory: webUiHome, env: { NODE_ENV: 'test' } })
    const databasePath = initial.layout.databasePath
    const created = await initial.memory.create({
      kind: 'general_preference',
      itemKey: 'database_recovery',
      reason: 'Exercise migration recovery.',
      explicitUserIntent: true,
      identity: { sessionId: 'recovery-session', profileId: 'default' },
      node: {
        valueJson: 'preserved',
        title: 'Database recovery preference',
        content: 'This memory must survive a database rebuild.',
      },
    })
    initial.conversations.createSession({ id: 'recovery-session', title: 'Recovery session' })
    initial.conversations.addMessage({
      sessionId: 'recovery-session',
      role: 'user',
      content: 'Keep this conversation.',
    })
    initial.close()

    const malformed = new EkkoDatabaseManager({ databasePath, env: { NODE_ENV: 'test' } })
    malformed.connection.exec(`
      ALTER TABLE schema_migrations RENAME TO schema_migrations_original;
      CREATE TABLE schema_migrations (component TEXT PRIMARY KEY);
    `)
    malformed.close()

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const recovered = setupEkkoAgent({ baseDirectory: webUiHome, env: { NODE_ENV: 'test' } })
    try {
      await expect(recovered.memory.get(created.nodeId!, { profileId: 'default' }))
        .resolves.toMatchObject({ valueJson: 'preserved', status: 'active' })
      expect(recovered.conversations.getSession('recovery-session')).toMatchObject({
        id: 'recovery-session',
        title: 'Recovery session',
      })
      expect(recovered.conversations.listMessages('recovery-session')).toMatchObject([
        { role: 'user', content: 'Keep this conversation.' },
      ])
      expect(recovered.database.connection.prepare(
        'SELECT max(version) AS version FROM schema_migrations WHERE component = ?',
      ).get('memory')).toMatchObject({ version: 8 })
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('database rebuilt after migration failure'))
      expect((await readdir(join(webUiHome, '.ekko')))
        .filter(name => name.includes('ekko.db.migration-failed-') && name.endsWith('.bak'))).toHaveLength(1)
    } finally {
      recovered.close()
      warning.mockRestore()
    }
  })

  it('restores the original database when creating the replacement database fails', async () => {
    const manager = new EkkoDatabaseManager({ baseDirectory: webUiHome })
    manager.connection.exec('CREATE TABLE original_records (value TEXT NOT NULL)')
    manager.connection.prepare('INSERT INTO original_records (value) VALUES (?)').run('preserved')

    const backupPath = manager.quarantineForRebuild()
    manager.connection.exec('CREATE TABLE failed_rebuild_records (value TEXT NOT NULL)')
    manager.connection.prepare('INSERT INTO failed_rebuild_records (value) VALUES (?)').run('failed')

    const failedRebuildPath = manager.restoreQuarantinedDatabase(backupPath)

    expect(manager.connection.prepare('SELECT value FROM original_records').all())
      .toEqual([{ value: 'preserved' }])
    expect(manager.connection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'failed_rebuild_records'",
    ).get()).toBeUndefined()
    expect(failedRebuildPath).toBeTruthy()
    expect(existsSync(failedRebuildPath!)).toBe(true)
    expect((await readdir(join(webUiHome, '.ekko')))
      .filter(name => name.includes('ekko.db.rebuild-failed-') && name.endsWith('.bak'))).toHaveLength(1)
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
