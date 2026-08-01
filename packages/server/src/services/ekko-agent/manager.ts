import {
  AgentRuntime,
  EkkoDatabaseManager,
  EkkoDirectoryManager,
  EkkoFileLogger,
  MemoryService,
  SqliteMemoryStore,
  type AgentRuntimeRunInput,
  type AgentRuntimeRunResult,
  type AgentRuntimeContextEstimate,
  type AgentRuntimeOptions,
} from '../../../../ekko-agent/src'
import { config } from '../../config'
import { getHermesBaseDir } from '../hermes/hermes-profile'
import { logger } from '../logger'

export interface GlobalEkkoAgentOptions {
  baseDirectory?: string
  profile?: string
  memory?: MemoryService | false
}

export class GlobalEkkoAgent {
  readonly createdAt = Date.now()
  lastUsedAt = this.createdAt
  runCount = 0
  private readonly options: GlobalEkkoAgentOptions
  private readonly directories: EkkoDirectoryManager
  private readonly skillDirectory: string
  private readonly logDirectory: string
  private readonly workspaceDirectory: string
  private readonly fileLogger: EkkoFileLogger
  private runtime?: AgentRuntime
  private memory?: MemoryService
  private memoryDatabasePath?: string

  constructor(options: GlobalEkkoAgentOptions = {}) {
    this.options = options
    this.directories = new EkkoDirectoryManager(options.baseDirectory)
    this.directories.initialize({ hermesRootDirectory: getHermesBaseDir() })
    this.skillDirectory = this.directories.profileSkillsDirectory(options.profile)
    this.logDirectory = this.directories.profileLogsDirectory(options.profile)
    this.workspaceDirectory = this.directories.profileWorkspaceDirectory(options.profile)
    this.fileLogger = new EkkoFileLogger({ directory: this.logDirectory })
    if (this.directories.lastSkillImport) {
      logger.info(
        { import: this.directories.lastSkillImport },
        '[ekko-agent] imported Hermes profile skills',
      )
    }
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    this.lastUsedAt = Date.now()
    this.runCount += 1
    return this.runtimeInstance().run(this.withDefaultWorkspace(input))
  }

  async runIsolated(
    options: Omit<AgentRuntimeOptions, 'logWriter' | 'logProfile'>,
    input: AgentRuntimeRunInput,
  ): Promise<AgentRuntimeRunResult> {
    const runtime = new AgentRuntime({
      ...options,
      logWriter: this.fileLogger,
      logProfile: this.options.profile || 'default',
    })
    return runtime.run(input)
  }

  async estimateContext(input: AgentRuntimeRunInput): Promise<AgentRuntimeContextEstimate> {
    return this.runtimeInstance().estimateContext(this.withDefaultWorkspace(input))
  }

  sessionWorkspaceDirectory(sessionId: string): string {
    return this.directories.sessionWorkspaceDirectory(this.options.profile || 'default', sessionId)
  }

  hasBackgroundTasks(sessionId?: string): boolean {
    return this.runtime?.hasBackgroundTasks(sessionId) ?? false
  }

  async abortBackgroundTasks(sessionId?: string): Promise<number> {
    return this.runtime?.abortBackgroundTasks(sessionId) ?? 0
  }

  close(): void {
    void this.runtime?.abortBackgroundTasks()
    this.memory?.close()
    this.memory = undefined
    this.runtime = undefined
  }

  status() {
    return {
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      runCount: this.runCount,
      memoryEnabled: this.memory?.isEnabled ?? false,
      memoryDatabasePath: this.memoryDatabasePath,
      dataDirectory: this.directories.rootDirectory,
      skillDirectory: this.skillDirectory,
      logDirectory: this.logDirectory,
      workspaceDirectory: this.workspaceDirectory,
      logFilePath: this.fileLogger.filePath,
      profile: this.options.profile || 'default',
    }
  }

  private runtimeInstance(): AgentRuntime {
    if (this.runtime) return this.runtime
    if (this.options.memory === false) {
      this.runtime = new AgentRuntime({
        skillDirectory: this.skillDirectory,
        logWriter: this.fileLogger,
        logProfile: this.options.profile || 'default',
      })
      return this.runtime
    }
    if (this.options.memory) {
      this.memory = this.options.memory
    } else {
      try {
        const database = new EkkoDatabaseManager({ databasePath: this.directories.databasePath })
        // Opening the store recreates the current schema after an explicit memory reset.
        const store = new SqliteMemoryStore(database)
        this.memoryDatabasePath = store.databasePath
        this.memory = new MemoryService({ store })
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error)
        logger.warn({ err: error }, '[ekko-agent] memory database initialization failed; memory is disabled')
        this.memory = new MemoryService({ enabled: false, warning })
      }
    }
    this.runtime = new AgentRuntime({
      memory: this.memory,
      skillDirectory: this.skillDirectory,
      logWriter: this.fileLogger,
      logProfile: this.options.profile || 'default',
    })
    return this.runtime
  }

  private withDefaultWorkspace(input: AgentRuntimeRunInput): AgentRuntimeRunInput {
    if (input.toolContext?.workspaceRoot || input.toolContext?.cwd) return input
    const sessionId = (
      input.toolContext?.sessionId ||
      (typeof input.metadata?.session_id === 'string' ? input.metadata.session_id : '')
    ).trim()
    if (!sessionId) return input
    const workspace = this.sessionWorkspaceDirectory(sessionId)
    return {
      ...input,
      toolContext: {
        ...input.toolContext,
        cwd: workspace,
        workspaceRoot: workspace,
        workspaceId: input.toolContext?.workspaceId || workspace,
      },
    }
  }
}

export function createGlobalEkkoAgent(
  options: GlobalEkkoAgentOptions = {},
): GlobalEkkoAgent {
  return new GlobalEkkoAgent(options)
}

const globalEkkoAgents = new Map<string, GlobalEkkoAgent>()

export function getGlobalEkkoAgent(profile = 'default'): GlobalEkkoAgent {
  const normalizedProfile = String(profile || '').trim() || 'default'
  let agent = globalEkkoAgents.get(normalizedProfile)
  if (!agent) {
    agent = createGlobalEkkoAgent({
      baseDirectory: config.appHome,
      profile: normalizedProfile,
    })
    globalEkkoAgents.set(normalizedProfile, agent)
  }
  return agent
}

export function hasGlobalEkkoBackgroundTasks(sessionId: string): boolean {
  for (const agent of globalEkkoAgents.values()) {
    if (agent.hasBackgroundTasks(sessionId)) return true
  }
  return false
}

export async function abortGlobalEkkoBackgroundTasks(sessionId: string): Promise<number> {
  const counts = await Promise.all(
    [...globalEkkoAgents.values()].map(agent => agent.abortBackgroundTasks(sessionId)),
  )
  return counts.reduce((sum, count) => sum + count, 0)
}
