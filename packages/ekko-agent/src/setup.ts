import { EkkoDatabaseManager } from './database'
import {
  EkkoDirectoryManager,
  type EkkoDirectoryInitializationOptions,
  type EkkoDirectoryLayout,
  type EkkoSkillImportResult,
} from './directories'
import { MemoryService } from './memory/service'
import { SqliteMemoryStore } from './memory/store'

export interface SetupEkkoAgentOptions extends EkkoDirectoryInitializationOptions {
  baseDirectory?: string
  profiles?: string[]
  env?: Record<string, string | undefined>
}

export interface EkkoProfileDirectoryLayout {
  profile: string
  skillDirectory: string
  logDirectory: string
  workspaceDirectory: string
}

/**
 * Process-level Ekko resources created before any agent run.
 *
 * The setup owns its database connection and memory service. Profile agents
 * borrow these resources and must not close them independently.
 */
export class EkkoAgentSetup {
  readonly directories: EkkoDirectoryManager
  readonly layout: EkkoDirectoryLayout
  readonly database: EkkoDatabaseManager
  readonly memoryStore: SqliteMemoryStore
  readonly memory: MemoryService
  readonly skillImport?: EkkoSkillImportResult
  private readonly profileLayouts = new Map<string, EkkoProfileDirectoryLayout>()
  private closed = false

  constructor(options: SetupEkkoAgentOptions = {}) {
    this.directories = new EkkoDirectoryManager(options.baseDirectory)
    this.layout = this.directories.initialize({
      hermesRootDirectory: options.hermesRootDirectory,
    })
    this.skillImport = this.directories.lastSkillImport
    this.database = new EkkoDatabaseManager({
      databasePath: this.layout.databasePath,
      env: options.env,
    })

    try {
      this.memoryStore = new SqliteMemoryStore(this.database)
      this.memory = new MemoryService({ store: this.memoryStore })
    } catch (error) {
      this.database.close()
      throw error
    }

    const profiles = new Set([
      'default',
      ...(this.skillImport?.profiles ?? []),
      ...(options.profiles ?? []),
    ])
    for (const profile of profiles) this.ensureProfile(profile)
  }

  ensureProfile(profile = 'default'): EkkoProfileDirectoryLayout {
    const normalizedProfile = String(profile || '').trim() || 'default'
    const existing = this.profileLayouts.get(normalizedProfile)
    if (existing) return existing
    const layout = {
      profile: normalizedProfile,
      skillDirectory: this.directories.profileSkillsDirectory(normalizedProfile),
      logDirectory: this.directories.profileLogsDirectory(normalizedProfile),
      workspaceDirectory: this.directories.profileWorkspaceDirectory(normalizedProfile),
    }
    this.profileLayouts.set(normalizedProfile, layout)
    return layout
  }

  profile(profile = 'default'): EkkoProfileDirectoryLayout {
    const normalizedProfile = String(profile || '').trim() || 'default'
    const layout = this.profileLayouts.get(normalizedProfile)
    if (!layout) {
      throw new Error(`Ekko profile is not set up: ${normalizedProfile}`)
    }
    return layout
  }

  profiles(): EkkoProfileDirectoryLayout[] {
    return [...this.profileLayouts.values()]
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.memory.close()
  }
}

export function setupEkkoAgent(options: SetupEkkoAgentOptions = {}): EkkoAgentSetup {
  return new EkkoAgentSetup(options)
}
