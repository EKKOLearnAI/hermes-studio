import {
  AgentRuntime,
  EkkoAgentSetup,
  EkkoFileLogger,
  MemoryService,
  setupEkkoAgent,
  type AgentRuntimeRunInput,
  type AgentRuntimeRunResult,
  type AgentRuntimeBoundaryInterruptRequest,
  type AgentRuntimeBoundaryInterruptResult,
  type AgentRuntimeContextEstimate,
  type AgentRuntimeOptions,
} from '../../../../ekko-agent/src'
import { config } from '../../config'
import { getHermesBaseDir, listProfileNamesFromDisk } from '../hermes/hermes-profile'
import { logger } from '../logger'
import { denyPendingEkkoToolApprovals } from './approvals'
import { cancelPendingEkkoClarifications } from './clarifications'

export interface GlobalEkkoAgentOptions {
  setup: EkkoAgentSetup
  profile?: string
  memory?: MemoryService | false
}

export class GlobalEkkoAgent {
  readonly createdAt = Date.now()
  lastUsedAt = this.createdAt
  runCount = 0
  private readonly options: GlobalEkkoAgentOptions
  private readonly setup: EkkoAgentSetup
  private readonly skillDirectory: string
  private readonly logDirectory: string
  private readonly workspaceDirectory: string
  private readonly fileLogger: EkkoFileLogger
  private runtime?: AgentRuntime
  private readonly memory?: MemoryService
  private readonly memoryDatabasePath?: string

  constructor(options: GlobalEkkoAgentOptions) {
    this.options = options
    this.setup = options.setup
    const profileLayout = this.setup.profile(options.profile)
    this.skillDirectory = profileLayout.skillDirectory
    this.logDirectory = profileLayout.logDirectory
    this.workspaceDirectory = profileLayout.workspaceDirectory
    this.fileLogger = new EkkoFileLogger({ directory: this.logDirectory })
    this.memory = options.memory === false ? undefined : options.memory ?? this.setup.memory
    this.memoryDatabasePath = this.memory === this.setup.memory
      ? this.setup.layout.databasePath
      : undefined
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
      toolAuthorizer: options.toolAuthorizer ?? this.setup.toolApprovals.authorize,
      logWriter: this.fileLogger,
      logProfile: this.options.profile || 'default',
    })
    return runtime.run(input)
  }

  async estimateContext(input: AgentRuntimeRunInput): Promise<AgentRuntimeContextEstimate> {
    return this.runtimeInstance().estimateContext(this.withDefaultWorkspace(input))
  }

  sessionWorkspaceDirectory(sessionId: string): string {
    return this.setup.directories.sessionWorkspaceDirectory(this.options.profile || 'default', sessionId)
  }

  hasBackgroundTasks(sessionId?: string): boolean {
    return this.runtime?.hasBackgroundTasks(sessionId) ?? false
  }

  async abortBackgroundTasks(sessionId?: string): Promise<number> {
    return this.runtime?.abortBackgroundTasks(sessionId) ?? 0
  }

  requestBoundaryInterrupt(
    input: AgentRuntimeBoundaryInterruptRequest,
  ): AgentRuntimeBoundaryInterruptResult {
    return this.runtime?.requestBoundaryInterrupt(input) ?? { status: 'not_running' }
  }

  close(): void {
    void this.runtime?.abortBackgroundTasks()
    this.runtime = undefined
  }

  status() {
    return {
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      runCount: this.runCount,
      memoryEnabled: this.memory?.isEnabled ?? false,
      memoryDatabasePath: this.memoryDatabasePath,
      dataDirectory: this.setup.layout.rootDirectory,
      configDirectory: this.setup.layout.configDirectory,
      configPath: this.setup.layout.configPath,
      skillDirectory: this.skillDirectory,
      logDirectory: this.logDirectory,
      workspaceDirectory: this.workspaceDirectory,
      logFilePath: this.fileLogger.filePath,
      profile: this.options.profile || 'default',
    }
  }

  private runtimeInstance(): AgentRuntime {
    if (this.runtime) return this.runtime
    this.runtime = new AgentRuntime({
      memory: this.memory,
      skillDirectory: this.skillDirectory,
      toolAuthorizer: this.setup.toolApprovals.authorize,
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
  options: GlobalEkkoAgentOptions,
): GlobalEkkoAgent {
  return new GlobalEkkoAgent(options)
}

export interface SetupGlobalEkkoAgentOptions {
  baseDirectory?: string
  profiles?: string[]
  env?: Record<string, string | undefined>
}

let globalEkkoSetup: EkkoAgentSetup | undefined
const globalEkkoAgents = new Map<string, GlobalEkkoAgent>()

export function setupGlobalEkkoAgent(
  options: SetupGlobalEkkoAgentOptions = {},
): EkkoAgentSetup {
  if (globalEkkoSetup) return globalEkkoSetup
  globalEkkoSetup = setupEkkoAgent({
    baseDirectory: options.baseDirectory ?? config.appHome,
    hermesRootDirectory: getHermesBaseDir(),
    profiles: options.profiles ?? listProfileNamesFromDisk(),
    env: options.env,
  })
  if (globalEkkoSetup.skillImport) {
    logger.info(
      { import: globalEkkoSetup.skillImport },
      '[ekko-agent] imported Hermes profile skills',
    )
  }
  logger.info({
    dataDirectory: globalEkkoSetup.layout.rootDirectory,
    configPath: globalEkkoSetup.layout.configPath,
    databasePath: globalEkkoSetup.layout.databasePath,
    profiles: globalEkkoSetup.profiles().map(profile => profile.profile),
  }, '[ekko-agent] setup complete')
  return globalEkkoSetup
}

export function getGlobalEkkoAgent(profile = 'default'): GlobalEkkoAgent {
  const normalizedProfile = String(profile || '').trim() || 'default'
  let agent = globalEkkoAgents.get(normalizedProfile)
  if (!agent) {
    const setup = setupGlobalEkkoAgent()
    setup.ensureProfile(normalizedProfile)
    agent = createGlobalEkkoAgent({
      setup,
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

export function closeGlobalEkkoAgent(): void {
  denyPendingEkkoToolApprovals()
  cancelPendingEkkoClarifications()
  for (const agent of globalEkkoAgents.values()) agent.close()
  globalEkkoAgents.clear()
  globalEkkoSetup?.close()
  globalEkkoSetup = undefined
}
