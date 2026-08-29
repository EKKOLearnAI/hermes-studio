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
        'SELECT component, version FROM schema_migrations WHERE component = ?',
      ).get('memory')).toMatchObject({ component: 'memory', version: 3 })
    } finally {
      setup.close()
    }
  })

  it('never imports Hermes skills and removes only their legacy non-built-in Ekko copies', async () => {
    const hermesRoot = join(webUiHome, 'hermes')
    const ekkoBase = join(webUiHome, 'web-ui')
    const hermesSkill = join(hermesRoot, 'skills', 'legacy-hermes-skill')
    const ekkoProfile = join(ekkoBase, '.ekko', 'skills', 'default')
    await mkdir(hermesSkill, { recursive: true })
    await mkdir(join(hermesRoot, 'skills', 'weather'), { recursive: true })
    await mkdir(join(hermesRoot, 'skills', 'image-gen'), { recursive: true })
    await mkdir(join(hermesRoot, 'skills', 'category', 'weather'), { recursive: true })
    await writeFile(join(hermesSkill, 'SKILL.md'), '# Hermes only\n')
    await writeFile(join(hermesRoot, 'skills', 'weather', 'SKILL.md'), '# Hermes weather\n')
    await writeFile(join(hermesRoot, 'skills', 'image-gen', 'SKILL.md'), '# Hermes image gen\n')
    await writeFile(join(hermesRoot, 'skills', 'category', 'weather', 'SKILL.md'), '# Categorized Hermes weather\n')
    await writeFile(join(hermesRoot, 'skills', 'category', 'DESCRIPTION.md'), '# Hermes category\n')
    const directories = new EkkoDirectoryManager(ekkoBase)
    directories.initialize()
    directories.profileSkillsDirectory('default')
    const builtinManifestPath = join(ekkoProfile, '.ekko-builtin-skills.json')
    const builtinManifest = JSON.parse(await readFile(builtinManifestPath, 'utf8'))
    delete builtinManifest['image-gen']
    await writeFile(builtinManifestPath, `${JSON.stringify(builtinManifest, null, 2)}\n`)
    await mkdir(join(ekkoProfile, 'legacy-hermes-skill'), { recursive: true })
    await mkdir(join(ekkoProfile, 'category', 'weather'), { recursive: true })
    await mkdir(join(ekkoProfile, 'ekko-local'), { recursive: true })
    await writeFile(join(ekkoProfile, 'legacy-hermes-skill', 'SKILL.md'), '# Modified after import\n')
    await writeFile(join(ekkoProfile, 'weather', 'SKILL.md'), '# Modified Ekko built-in\n')
    await writeFile(join(ekkoProfile, 'image-gen', 'SKILL.md'), '# Hermes image gen\n')
    await writeFile(join(ekkoProfile, 'category', 'weather', 'SKILL.md'), '# Categorized Hermes weather\n')
    await writeFile(join(ekkoProfile, 'category', 'DESCRIPTION.md'), '# Hermes category\n')
    await writeFile(join(ekkoProfile, 'ekko-local', 'SKILL.md'), '# Ekko local\n')

    directories.initialize({ hermesRootDirectory: hermesRoot })

    expect(existsSync(join(ekkoProfile, 'legacy-hermes-skill'))).toBe(false)
    await expect(readFile(join(ekkoProfile, 'weather', 'SKILL.md'), 'utf8'))
      .resolves.toBe('# Modified Ekko built-in\n')
    expect(existsSync(join(ekkoProfile, 'image-gen'))).toBe(false)
    expect(existsSync(join(ekkoProfile, 'category'))).toBe(false)
    await expect(readFile(join(ekkoProfile, 'ekko-local', 'SKILL.md'), 'utf8'))
      .resolves.toBe('# Ekko local\n')
    await expect(readFile(join(hermesSkill, 'SKILL.md'), 'utf8'))
      .resolves.toBe('# Hermes only\n')
    await expect(readFile(
      join(ekkoBase, '.ekko', '.ekko-hermes-skill-cleanup-v2.json'),
      'utf8',
    ).then(JSON.parse)).resolves.toMatchObject({
      version: 2,
      removed: expect.arrayContaining([
        { profile: 'default', skill: 'legacy-hermes-skill' },
        { profile: 'default', skill: 'image-gen' },
        { profile: 'default', skill: 'category/weather' },
      ]),
    })
    directories.profileSkillsDirectory('default')
    await expect(readFile(join(ekkoProfile, 'image-gen', 'SKILL.md'), 'utf8'))
      .resolves.not.toBe('# Hermes image gen\n')

    await mkdir(join(ekkoProfile, 'legacy-hermes-skill'), { recursive: true })
    await writeFile(join(ekkoProfile, 'legacy-hermes-skill', 'SKILL.md'), '# Created after cleanup\n')
    directories.initialize({ hermesRootDirectory: hermesRoot })
    await expect(readFile(join(ekkoProfile, 'legacy-hermes-skill', 'SKILL.md'), 'utf8'))
      .resolves.toBe('# Created after cleanup\n')
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
