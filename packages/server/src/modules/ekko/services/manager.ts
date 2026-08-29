import {
  AgentRuntime,
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  EkkoAgentSetup,
  EkkoFileLogger,
  EkkoRuntimeLogger,
  MemoryService,
  ModelMemoryExtractor,
  createModelClient,
  resolveModelProviderConfigs,
  setupEkkoAgent,
  type AgentRuntimeRunInput,
  type AgentRuntimeRunResult,
  type AgentRuntimeBoundaryInterruptRequest,
  type AgentRuntimeBoundaryInterruptResult,
  type AgentRuntimeContextEstimate,
  type AgentRuntimeOptions,
  type EkkoConfig,
  type EkkoConfigPatch,
  type MemoryReviewJob,
  type MemoryReviewExtractorResolution,
} from '../../../../../ekko-agent/src'
import { config } from '../../studio/public/config'
import { logger } from '../../studio/public/logging'
import {
  getProfilesBaseDir,
  listProfileNames,
  readConfigYamlForProfile,
} from '../../studio/public/profile-config'
import { denyPendingEkkoToolApprovals } from './approvals'
import { cancelPendingEkkoClarifications } from './clarifications'
import { createEkkoAuthorizedProviderFetch, resolveEkkoProviderRuntimeConfig } from './provider-runtime'

export interface GlobalEkkoAgentOptions {
  setup: EkkoAgentSetup
  profile?: string
  memory?: MemoryService | false
  /** Installation-wide values applied before this global agent is created. */
  config?: EkkoConfigPatch
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
  private fileLogger: EkkoFileLogger
  private runtime?: AgentRuntime
  private activeRuns = 0
  private runtimeRefreshPending = false
  private readonly memory?: MemoryService
  private readonly memoryDatabasePath?: string

  constructor(options: GlobalEkkoAgentOptions) {
    this.options = options
    this.setup = options.setup
    if (options.config) this.setup.config.update(options.config)
    const profileLayout = this.setup.profile(options.profile)
    this.skillDirectory = profileLayout.skillDirectory
    this.logDirectory = profileLayout.logDirectory
    this.workspaceDirectory = profileLayout.workspaceDirectory
    this.fileLogger = this.createFileLogger()
    this.memory = options.memory === false ? undefined : options.memory ?? this.setup.memory
    this.memoryDatabasePath = this.memory === this.setup.memory
      ? this.setup.layout.databasePath
      : undefined
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    this.lastUsedAt = Date.now()
    this.runCount += 1
    const runtime = this.runtimeInstance()
    this.activeRuns += 1
    try {
      return await runtime.run(this.withDefaultWorkspace(input))
    } finally {
      this.activeRuns -= 1
      this.applyPendingRuntimeRefresh()
    }
  }

  async runIsolated(
    options: Omit<AgentRuntimeOptions, 'logWriter' | 'logProfile'>,
    input: AgentRuntimeRunInput,
  ): Promise<AgentRuntimeRunResult> {
    const runtime = this.setup.createRuntime({
      ...options,
      profile: this.options.profile || 'default',
      memory: options.memory ?? false,
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
    const count = await (this.runtime?.abortBackgroundTasks(sessionId) ?? 0)
    this.applyPendingRuntimeRefresh()
    return count
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

  refreshRuntime(): 'refreshed' | 'deferred' {
    if (this.activeRuns > 0 || this.hasBackgroundTasks()) {
      this.runtimeRefreshPending = true
      return 'deferred'
    }
    this.runtime = undefined
    this.fileLogger = this.createFileLogger()
    this.runtimeRefreshPending = false
    return 'refreshed'
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

  readConfig(): EkkoConfig {
    return this.setup.config.read()
  }

  private runtimeInstance(): AgentRuntime {
    this.applyPendingRuntimeRefresh()
    if (this.runtime) return this.runtime
    this.runtime = this.setup.createRuntime({
      profile: this.options.profile || 'default',
      memory: this.memory ?? false,
      logWriter: this.fileLogger,
      logProfile: this.options.profile || 'default',
    })
    return this.runtime
  }

  private applyPendingRuntimeRefresh(): void {
    if (!this.runtimeRefreshPending || this.activeRuns > 0 || this.hasBackgroundTasks()) return
    this.runtime = undefined
    this.fileLogger = this.createFileLogger()
    this.runtimeRefreshPending = false
  }

  private createFileLogger(): EkkoFileLogger {
    return new EkkoFileLogger({
      directory: this.logDirectory,
      maxBytes: this.setup.config.read().logging.maxBytes,
    })
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
  config?: EkkoConfigPatch
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
    hermesRootDirectory: getProfilesBaseDir(),
    profiles: options.profiles ?? listProfileNames(),
    config: options.config,
    env: options.env,
  })
  globalEkkoSetup.memory.registerReviewExtractorResolver(
    job => resolveStudioMemoryReviewExtractor(globalEkkoSetup!, job),
  )
  logger.info({
    dataDirectory: globalEkkoSetup.layout.rootDirectory,
    configPath: globalEkkoSetup.layout.configPath,
    databasePath: globalEkkoSetup.layout.databasePath,
    profiles: globalEkkoSetup.profiles().map(profile => profile.profile),
  }, '[ekko-agent] setup complete')
  return globalEkkoSetup
}

async function resolveStudioMemoryReviewExtractor(
  setup: EkkoAgentSetup,
  job: MemoryReviewJob,
): Promise<MemoryReviewExtractorResolution | undefined> {
  const current = await currentProfileModel(job.profileId)
  const preferOriginal = job.attempt <= 1
  const provider = String(
    preferOriginal ? job.preferredProvider || current.provider : current.provider || job.preferredProvider,
  ).trim()
  const model = String(
    preferOriginal ? job.preferredModel || current.model : current.model || job.preferredModel,
  ).trim()
  if (!provider || !model) return undefined
  try {
    const runtime = await resolveEkkoProviderRuntimeConfig({
      profile: job.profileId,
      provider,
      model,
    })
    const { providerConfig } = resolveModelProviderConfigs({
      provider,
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      model,
      apiMode: runtime.apiMode,
      timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    })
    const authorizedFetch = createEkkoAuthorizedProviderFetch({
      profile: job.profileId,
      provider,
      model,
      accessToken: runtime.apiKey,
    })
    return {
      provider,
      model,
      extractor: new ModelMemoryExtractor({
        mode: 'review',
        modelClient: createModelClient(providerConfig, { fetch: authorizedFetch }),
        memory: setup.memory,
        model,
        fallback: false,
        maxModelRetries: 0,
        requestLogger: new EkkoRuntimeLogger(new EkkoFileLogger({
          directory: setup.profile(job.profileId).logDirectory,
          maxBytes: setup.config.read().logging.maxBytes,
        }), {
          profile: job.profileId,
          sessionId: job.sessionId,
        }),
        requestRunId: `memory-review-${job.id.slice(0, 12)}`,
      }),
    }
  } catch {
    return undefined
  }
}

async function currentProfileModel(profile: string): Promise<{ provider: string; model: string }> {
  try {
    const config = await readConfigYamlForProfile(profile)
    const modelConfig = config?.model
    const model = typeof modelConfig === 'string'
      ? modelConfig.trim()
      : String(modelConfig?.default || '').trim()
    const configuredProvider = typeof modelConfig === 'object'
      ? String(modelConfig?.provider || '').trim()
      : ''
    return {
      model,
      provider: configuredProvider === 'claude-oauth' ? 'anthropic' : configuredProvider,
    }
  } catch {
    return { provider: '', model: '' }
  }
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

export function refreshGlobalEkkoAgentRuntimes(): { refreshed: number; deferred: number } {
  let refreshed = 0
  let deferred = 0
  for (const agent of globalEkkoAgents.values()) {
    if (agent.refreshRuntime() === 'refreshed') refreshed += 1
    else deferred += 1
  }
  return { refreshed, deferred }
}

export function closeGlobalEkkoAgent(): void {
  denyPendingEkkoToolApprovals()
  cancelPendingEkkoClarifications()
  for (const agent of globalEkkoAgents.values()) agent.close()
  globalEkkoAgents.clear()
  globalEkkoSetup?.close()
  globalEkkoSetup = undefined
}
