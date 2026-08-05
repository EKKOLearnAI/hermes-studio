import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  EKKO_CONFIG_DIRECTORY_NAME,
  EKKO_CONFIG_FILE_NAME,
  serializeDefaultEkkoConfig,
} from './config'

export interface EkkoDirectoryLayout {
  baseDirectory: string
  rootDirectory: string
  databasePath: string
  configDirectory: string
  configPath: string
  skillsDirectory: string
  logsDirectory: string
  workspaceDirectory: string
}

export interface EkkoDirectoryInitializationOptions {
  /**
   * Hermes Agent's root data directory. When Ekko's skills directory does not
   * exist yet, all default and named profile skills are imported once.
   */
  hermesRootDirectory?: string
}

export interface EkkoSkillImportResult {
  hermesRootDirectory: string
  profiles: string[]
}

/**
 * Owns Ekko Agent's filesystem layout.
 *
 * Callers provide one base directory. Ekko keeps every owned artifact under
 * `<baseDirectory>/.ekko`; without an explicit base it uses the user's home.
 */
export class EkkoDirectoryManager {
  readonly baseDirectory: string
  readonly rootDirectory: string
  readonly databasePath: string
  readonly configDirectory: string
  readonly configPath: string
  readonly skillsDirectory: string
  readonly logsDirectory: string
  readonly workspaceDirectory: string
  lastSkillImport?: EkkoSkillImportResult

  constructor(baseDirectory: string = homedir()) {
    this.baseDirectory = resolve(baseDirectory || homedir())
    this.rootDirectory = join(this.baseDirectory, '.ekko')
    this.databasePath = join(this.rootDirectory, 'ekko.db')
    this.configDirectory = join(this.rootDirectory, EKKO_CONFIG_DIRECTORY_NAME)
    this.configPath = join(this.configDirectory, EKKO_CONFIG_FILE_NAME)
    this.skillsDirectory = join(this.rootDirectory, 'skills')
    this.logsDirectory = join(this.rootDirectory, 'logs')
    this.workspaceDirectory = join(this.rootDirectory, 'workspace')
  }

  initialize(options: EkkoDirectoryInitializationOptions = {}): EkkoDirectoryLayout {
    this.lastSkillImport = undefined
    this.initializeConfigDirectory()
    if (!existsSync(this.skillsDirectory) && options.hermesRootDirectory) {
      this.lastSkillImport = this.importHermesProfileSkills(options.hermesRootDirectory)
    } else {
      mkdirSync(this.skillsDirectory, { recursive: true })
    }
    mkdirSync(this.workspaceDirectory, { recursive: true })
    return this.layout()
  }

  /**
   * Creates the global configuration boundary without overwriting an existing
   * file. Profile-specific configuration directories are intentionally not
   * created or loaded yet.
   */
  initializeConfigDirectory(): string {
    mkdirSync(this.configDirectory, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(this.configPath, serializeDefaultEkkoConfig(), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (!isErrorWithCode(error, 'EEXIST')) throw error
    }
    return this.configPath
  }

  profileSkillsDirectory(profile = 'default'): string {
    const directory = join(this.skillsDirectory, profileDirectoryName(profile))
    mkdirSync(directory, { recursive: true })
    return directory
  }

  profileLogsDirectory(profile = 'default'): string {
    const directory = this.profileLogsPath(profile)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  profileLogsPath(profile = 'default'): string {
    return join(this.logsDirectory, profileDirectoryName(profile))
  }

  profileWorkspaceDirectory(profile = 'default'): string {
    const directory = join(this.workspaceDirectory, profileDirectoryName(profile))
    mkdirSync(directory, { recursive: true })
    return directory
  }

  sessionWorkspaceDirectory(profile: string, sessionId: string): string {
    const directory = join(
      this.workspaceDirectory,
      profileDirectoryName(profile),
      sessionDirectoryName(sessionId),
    )
    mkdirSync(directory, { recursive: true })
    return directory
  }

  layout(): EkkoDirectoryLayout {
    return {
      baseDirectory: this.baseDirectory,
      rootDirectory: this.rootDirectory,
      databasePath: this.databasePath,
      configDirectory: this.configDirectory,
      configPath: this.configPath,
      skillsDirectory: this.skillsDirectory,
      logsDirectory: this.logsDirectory,
      workspaceDirectory: this.workspaceDirectory,
    }
  }

  private importHermesProfileSkills(hermesRootDirectory: string): EkkoSkillImportResult {
    const sources = hermesProfileSkillSources(hermesRootDirectory)
    mkdirSync(this.rootDirectory, { recursive: true })
    const stagingDirectory = join(this.rootDirectory, `.skills-import-${randomUUID()}`)

    try {
      mkdirSync(stagingDirectory, { recursive: false })
      for (const source of sources) {
        cpSync(source.directory, join(stagingDirectory, source.profile), {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        })
      }
      renameSync(stagingDirectory, this.skillsDirectory)
      return {
        hermesRootDirectory: resolve(hermesRootDirectory),
        profiles: sources.map(source => source.profile),
      }
    } catch (error) {
      rmSync(stagingDirectory, { recursive: true, force: true })
      throw error
    }
  }
}

function profileDirectoryName(value: string): string {
  const profile = String(value || '').trim() || 'default'
  return safeDirectoryName(profile, 'profile')
}

function sessionDirectoryName(value: string): string {
  const sessionId = String(value || '').trim()
  if (!sessionId) throw new Error('Ekko session directory name is required')
  return safeDirectoryName(sessionId, 'session')
}

function safeDirectoryName(value: string, kind: 'profile' | 'session'): string {
  if (
    value === '.' ||
    value === '..' ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(value)
  ) {
    throw new Error(`Invalid Ekko ${kind} directory name: ${value}`)
  }
  return value
}

function hermesProfileSkillSources(
  hermesRootDirectory: string,
): Array<{ profile: string; directory: string }> {
  const root = resolve(hermesRootDirectory)
  const sources: Array<{ profile: string; directory: string }> = []
  const defaultSkills = join(root, 'skills')
  if (isDirectory(defaultSkills)) {
    sources.push({ profile: 'default', directory: defaultSkills })
  }

  const profilesDirectory = join(root, 'profiles')
  let entries
  try {
    entries = readdirSync(profilesDirectory, { withFileTypes: true })
  } catch {
    return sources
  }

  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'default') continue
    let profile
    try {
      profile = profileDirectoryName(entry.name)
    } catch {
      continue
    }
    const skillsDirectory = join(profilesDirectory, entry.name, 'skills')
    if (isDirectory(skillsDirectory)) {
      sources.push({ profile, directory: skillsDirectory })
    }
  }
  return sources
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
