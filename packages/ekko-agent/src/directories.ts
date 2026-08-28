import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  EKKO_CONFIG_DIRECTORY_NAME,
  EKKO_CONFIG_FILE_NAME,
  serializeDefaultEkkoConfig,
} from './config'

const BUILTIN_SKILL_MANIFEST_FILENAME = '.ekko-builtin-skills.json'
const BUILTIN_SKILL_MANIFEST_OWNER = 'ekko-agent'
const BUILTIN_SKILL_HASH_IGNORED_FILENAMES = new Set(['.DS_Store', 'Thumbs.db'])

interface BuiltinSkillManifestEntry {
  owner?: string
  sourceHash?: string
  installedHash?: string
}

type BuiltinSkillManifest = Record<string, BuiltinSkillManifestEntry>

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
  private builtinSkills?: EkkoBuiltinSkillSynchronizer

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
    this.builtinSkills = EkkoBuiltinSkillSynchronizer.createDefault()
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
    this.builtinSkills?.sync(directory)
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

  /** Discover persisted profiles from every profile-owned directory root. */
  profileNames(): string[] {
    const profiles = new Set<string>()
    for (const root of [this.skillsDirectory, this.logsDirectory, this.workspaceDirectory]) {
      let entries
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        try {
          profiles.add(profileDirectoryName(entry.name))
        } catch {
          // Ignore filesystem entries that cannot represent an Ekko profile.
        }
      }
    }
    return [...profiles].sort((left, right) => left.localeCompare(right))
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

class EkkoBuiltinSkillSynchronizer {
  private constructor(private readonly sourceDirectory: string) {}

  static createDefault(): EkkoBuiltinSkillSynchronizer | undefined {
    const override = process.env.EKKO_BUILTIN_SKILLS_DIR?.trim()
    const sourceDirectory = override
      ? resolve(override)
      : [
          // Production server bundle: dist/server/index.js with dist/ekko-skills.
          resolve(__dirname, '../ekko-skills'),
          // Ekko package source/build: src or dist with package/skills.
          resolve(__dirname, '../skills'),
          resolve(process.cwd(), 'packages/ekko-agent/skills'),
        ].find(isDirectory)
    return sourceDirectory ? new EkkoBuiltinSkillSynchronizer(sourceDirectory) : undefined
  }

  sync(targetDirectory: string): void {
    if (!isDirectory(this.sourceDirectory)) return
    const target = resolve(targetDirectory)
    mkdirSync(target, { recursive: true })
    const manifest = readBuiltinSkillManifest(target)
    let manifestChanged = false

    for (const entry of readdirSync(this.sourceDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        !isFile(join(this.sourceDirectory, entry.name, 'SKILL.md'))
      ) continue

      const sourceSkillDirectory = join(this.sourceDirectory, entry.name)
      const targetSkillDirectory = join(target, entry.name)
      const sourceHash = hashBuiltinSkillDirectory(sourceSkillDirectory)

      if (!existsSync(targetSkillDirectory)) {
        const installedHash = installBuiltinSkill(sourceSkillDirectory, targetSkillDirectory)
        manifest[entry.name] = {
          owner: BUILTIN_SKILL_MANIFEST_OWNER,
          sourceHash,
          installedHash,
        }
        manifestChanged = true
        continue
      }

      if (!isPlainDirectory(targetSkillDirectory)) continue
      const currentHash = hashBuiltinSkillDirectory(targetSkillDirectory)
      const manifestEntry = manifest[entry.name]
      const isUnchangedManagedCopy = manifestEntry?.owner === BUILTIN_SKILL_MANIFEST_OWNER &&
        manifestEntry.installedHash === currentHash
      const isIdenticalUnmanagedCopy = !manifestEntry && currentHash === sourceHash

      if (isUnchangedManagedCopy && manifestEntry.sourceHash !== sourceHash) {
        const installedHash = installBuiltinSkill(sourceSkillDirectory, targetSkillDirectory)
        manifest[entry.name] = {
          owner: BUILTIN_SKILL_MANIFEST_OWNER,
          sourceHash,
          installedHash,
        }
        manifestChanged = true
      } else if (isIdenticalUnmanagedCopy) {
        manifest[entry.name] = {
          owner: BUILTIN_SKILL_MANIFEST_OWNER,
          sourceHash,
          installedHash: currentHash,
        }
        manifestChanged = true
      }
    }

    if (manifestChanged) writeBuiltinSkillManifest(target, manifest)
  }
}

function installBuiltinSkill(sourceDirectory: string, targetDirectory: string): string {
  const parentDirectory = resolve(targetDirectory, '..')
  const name = basename(targetDirectory)
  const stagingDirectory = join(parentDirectory, `.${name}.${randomUUID()}.tmp`)
  const previousDirectory = join(parentDirectory, `.${name}.${randomUUID()}.previous`)

  try {
    cpSync(sourceDirectory, stagingDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true })
    throw error
  }

  if (!existsSync(targetDirectory)) {
    renameSync(stagingDirectory, targetDirectory)
    return hashBuiltinSkillDirectory(targetDirectory)
  }

  renameSync(targetDirectory, previousDirectory)
  try {
    renameSync(stagingDirectory, targetDirectory)
  } catch (error) {
    renameSync(previousDirectory, targetDirectory)
    rmSync(stagingDirectory, { recursive: true, force: true })
    throw error
  }
  rmSync(previousDirectory, { recursive: true, force: true })
  return hashBuiltinSkillDirectory(targetDirectory)
}

function readBuiltinSkillManifest(targetDirectory: string): BuiltinSkillManifest {
  try {
    const parsed = JSON.parse(readFileSync(
      join(targetDirectory, BUILTIN_SKILL_MANIFEST_FILENAME),
      'utf8',
    ))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as BuiltinSkillManifest
      : {}
  } catch {
    return {}
  }
}

function writeBuiltinSkillManifest(
  targetDirectory: string,
  manifest: BuiltinSkillManifest,
): void {
  const sorted: BuiltinSkillManifest = {}
  for (const name of Object.keys(manifest).sort()) sorted[name] = manifest[name]
  writeFileSync(
    join(targetDirectory, BUILTIN_SKILL_MANIFEST_FILENAME),
    `${JSON.stringify(sorted, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

function hashBuiltinSkillDirectory(directory: string): string {
  const hash = createHash('sha256')
  hashBuiltinSkillDirectoryInto(hash, directory, '')
  return hash.digest('hex')
}

function hashBuiltinSkillDirectoryInto(
  hash: ReturnType<typeof createHash>,
  directory: string,
  relativeDirectory: string,
): void {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => !BUILTIN_SKILL_HASH_IGNORED_FILENAMES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      hash.update(`dir\0${relativePath}\0`)
      hashBuiltinSkillDirectoryInto(hash, fullPath, relativePath)
    } else if (entry.isFile()) {
      hash.update(`file\0${relativePath}\0`)
      hash.update(readFileSync(fullPath))
      hash.update('\0')
    }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isPlainDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
