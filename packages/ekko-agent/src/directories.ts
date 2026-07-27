import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface EkkoDirectoryLayout {
  baseDirectory: string
  rootDirectory: string
  databasePath: string
  skillsDirectory: string
  logsDirectory: string
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
  readonly skillsDirectory: string
  readonly logsDirectory: string
  lastSkillImport?: EkkoSkillImportResult

  constructor(baseDirectory: string = homedir()) {
    this.baseDirectory = resolve(baseDirectory || homedir())
    this.rootDirectory = join(this.baseDirectory, '.ekko')
    this.databasePath = join(this.rootDirectory, 'ekko.db')
    this.skillsDirectory = join(this.rootDirectory, 'skills')
    this.logsDirectory = join(this.rootDirectory, 'logs')
  }

  initialize(options: EkkoDirectoryInitializationOptions = {}): EkkoDirectoryLayout {
    this.lastSkillImport = undefined
    if (!existsSync(this.skillsDirectory) && options.hermesRootDirectory) {
      this.lastSkillImport = this.importHermesProfileSkills(options.hermesRootDirectory)
    } else {
      mkdirSync(this.skillsDirectory, { recursive: true })
    }
    return this.layout()
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

  layout(): EkkoDirectoryLayout {
    return {
      baseDirectory: this.baseDirectory,
      rootDirectory: this.rootDirectory,
      databasePath: this.databasePath,
      skillsDirectory: this.skillsDirectory,
      logsDirectory: this.logsDirectory,
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
  if (
    profile === '.' ||
    profile === '..' ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(profile)
  ) {
    throw new Error(`Invalid Ekko profile directory name: ${profile}`)
  }
  return profile
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
