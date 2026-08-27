import { EkkoDatabaseManager } from './database'
import {
  EkkoDirectoryManager,
  type EkkoDirectoryInitializationOptions,
  type EkkoDirectoryLayout,
  type EkkoSkillImportResult,
} from './directories'
import { MemoryService } from './memory/service'
import { resolveEkkoDatabasePath } from './memory/paths'
import { SqliteMemoryStore } from './memory/store'
import { EkkoToolApprovalService } from './tools/approval'
import {
  EkkoConfigStore,
  type ConfiguredModelAuthorizationEntry,
  type ConfiguredModelProviderEntry,
  type InstallModelProviderPresetOptions,
} from './config-store'
import { EkkoConversationStore } from './conversations/store'
import {
  createConfiguredModelClient,
  modelRequestDefaultsFromConfig,
  resolveConfiguredModelProvider,
  type ResolveConfiguredModelProviderInput,
} from './model/provider-config'
import type { ModelClient, ModelClientOptions, ModelProviderConfig } from './model/types'
import {
  EkkoModelAuthorizationManager,
  type EkkoModelAuthorizationCredentials,
  type EkkoModelAuthorizationRefresher,
} from './model/authorization'
import { AuthorizedModelClient } from './model/authorized-client'
import { EkkoModelManager } from './model/manager'
import type { EkkoModelProviderPreset } from './model/provider-presets'
import { AgentRuntime } from './runtime/runtime'
import { EkkoRuntimeManager } from './runtime/manager'
import type { AgentRuntimeOptions } from './runtime/types'
import { createDefaultToolRegistry } from './tools/registry'
import { EkkoToolManager } from './tools/manager'
import { EkkoSkillManager } from './skills/manager'
import { EkkoFileLogger } from './logging/file-logger'
import type {
  EkkoConfig,
  EkkoConfigPatch,
  EkkoModelAuthorizationSettings,
  EkkoModelProviderSettings,
} from './config'
import { EkkoAgentManager } from './agent/manager'
import { EkkoProfileAgent } from './agent/profile-agent'

export interface SetupEkkoAgentOptions extends EkkoDirectoryInitializationOptions {
  baseDirectory?: string
  profiles?: string[]
  env?: Record<string, string | undefined>
  packageRoot?: string
  authorizationRefresher?: EkkoModelAuthorizationRefresher
  authorizationFetch?: ModelClientOptions['fetch']
  authorizationNow?: () => number
}

export interface EkkoProfileDirectoryLayout {
  profile: string
  skillDirectory: string
  logDirectory: string
  workspaceDirectory: string
}

export interface CreateEkkoRuntimeOptions extends Omit<AgentRuntimeOptions, 'memory'> {
  profile?: string
  provider?: string
  model?: string
  apiKey?: string
  clientOptions?: ModelClientOptions
  /** Disable the shared memory service for this runtime without changing global config. */
  memory?: AgentRuntimeOptions['memory'] | false
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
  readonly config: EkkoConfigStore
  readonly database: EkkoDatabaseManager
  readonly memoryStore: SqliteMemoryStore
  readonly memory: MemoryService
  readonly conversations: EkkoConversationStore
  readonly conversation: EkkoConversationStore
  readonly authorizations: EkkoModelAuthorizationManager
  readonly authorization: EkkoModelAuthorizationManager
  readonly model: EkkoModelManager
  readonly tool: EkkoToolManager
  readonly skill: EkkoSkillManager
  readonly runtime: EkkoRuntimeManager
  readonly agent: EkkoAgentManager
  readonly agents: EkkoAgentManager
  readonly default: EkkoProfileAgent
  readonly skillImport?: EkkoSkillImportResult
  private readonly profileLayouts = new Map<string, EkkoProfileDirectoryLayout>()
  private readonly directProfileProperties = new Set<string>()
  private currentToolApprovals: EkkoToolApprovalService
  private readonly unsubscribeConfig: () => void
  private closed = false

  constructor(options: SetupEkkoAgentOptions = {}) {
    this.directories = new EkkoDirectoryManager(options.baseDirectory)
    this.layout = {
      ...this.directories.initialize({
        hermesRootDirectory: options.hermesRootDirectory,
      }),
      databasePath: resolveEkkoDatabasePath({
        baseDirectory: options.baseDirectory,
        env: options.env,
        packageRoot: options.packageRoot,
      }),
    }
    this.skillImport = this.directories.lastSkillImport
    this.config = new EkkoConfigStore({ configPath: this.layout.configPath })
    const config = this.config.ensureDefaults()
    this.authorizations = new EkkoModelAuthorizationManager({
      config: this.config,
      refresher: options.authorizationRefresher,
      fetch: options.authorizationFetch,
      now: options.authorizationNow,
    })
    this.currentToolApprovals = this.createToolApprovals(config)
    this.unsubscribeConfig = this.config.onDidChange(nextConfig => {
      this.currentToolApprovals = this.createToolApprovals(nextConfig)
    })
    this.authorization = this.authorizations
    this.tool = new EkkoToolManager({
      createRegistry: profile => this.createProfileToolRegistry(profile),
    })
    this.skill = new EkkoSkillManager(this.tool)
    this.model = new EkkoModelManager({
      config: this.config,
      authorizations: this.authorizations,
      resolveProvider: input => this.modelProviderConfig(input),
      createClient: (input, clientOptions) => this.createModelClient(input, clientOptions),
    })
    this.runtime = new EkkoRuntimeManager({
      create: runtimeOptions => this.createRuntime(runtimeOptions),
    })
    this.database = new EkkoDatabaseManager({
      databasePath: this.layout.databasePath,
      env: options.env,
    })

    try {
      this.memoryStore = new SqliteMemoryStore(this.database)
      this.memory = this.createMemoryService(config)
      this.conversations = new EkkoConversationStore(this.database)
      this.conversation = this.conversations
    } catch (error) {
      this.database.close()
      throw error
    }

    this.agent = new EkkoAgentManager({
      create: profile => this.createProfileAgent(profile),
      onCreate: profileAgent => this.attachProfileAgent(profileAgent),
      onRemove: profileAgent => this.detachProfileAgent(profileAgent),
    })
    this.agents = this.agent

    const profiles = new Set([
      'default',
      ...this.directories.profileNames(),
      ...(this.skillImport?.profiles ?? []),
      ...(options.profiles ?? []),
    ])
    try {
      for (const profile of profiles) this.agent.ensure(profile)
      this.default = this.agent.get('default')
    } catch (error) {
      this.close()
      throw error
    }
  }

  ensureProfile(profile = 'default'): EkkoProfileDirectoryLayout {
    const layout = this.ensureProfileLayout(profile)
    this.agent.ensure(layout.profile)
    return layout
  }

  private ensureProfileLayout(profile = 'default'): EkkoProfileDirectoryLayout {
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
    return this.agent.list().map(profileAgent => profileAgent.layout)
  }

  getAgent(profile = 'default'): EkkoProfileAgent {
    return this.agent.get(profile)
  }

  get toolApprovals(): EkkoToolApprovalService {
    return this.currentToolApprovals
  }

  modelProviderConfig(
    input: Omit<ResolveConfiguredModelProviderInput, 'config'> = {},
  ): ModelProviderConfig {
    return resolveConfiguredModelProvider({
      ...input,
      config: this.config.read(),
    })
  }

  createModelClient(
    input: Omit<ResolveConfiguredModelProviderInput, 'config'> = {},
    clientOptions: ModelClientOptions = {},
  ): ModelClient {
    const config = this.config.read()
    const provider = String(input.provider || config.model.defaultProvider || '').trim()
    const providerSettings = config.model.providers[provider]
    if (
      provider &&
      input.apiKey === undefined &&
      (providerSettings?.authType === 'oauth' || !!config.model.authorizations[provider])
    ) {
      return new AuthorizedModelClient({
        config: this.config,
        authorizations: this.authorizations,
        provider,
        model: input.model,
        clientOptions,
      })
    }
    return createConfiguredModelClient({
      ...input,
      config,
      clientOptions,
    })
  }

  createRuntime(options: CreateEkkoRuntimeOptions = {}): AgentRuntime {
    const {
      profile = 'default',
      provider,
      model,
      apiKey,
      clientOptions,
      memory,
      ...runtimeOverrides
    } = options
    const config = this.config.read()
    const profileLayout = this.ensureProfile(profile)
    const toolsEnabled = runtimeOverrides.toolsEnabled ?? config.tools.enabled
    const skillsEnabled = runtimeOverrides.skillsEnabled ?? config.skills.enabled
    const skillDirectory = runtimeOverrides.skillDirectory ?? profileLayout.skillDirectory
    const toolAuthorizer = runtimeOverrides.toolAuthorizer ?? this.toolApprovals.authorize
    const selectedProvider = String(provider || config.model.defaultProvider || '').trim()
    const modelClient = runtimeOverrides.modelClient ?? (selectedProvider
      ? this.createModelClient({ provider: selectedProvider, model, apiKey }, clientOptions)
      : undefined)
    const tools = runtimeOverrides.tools ?? (toolsEnabled
      ? this.tool.createRuntimeRegistry(
          profile,
          skillDirectory === profileLayout.skillDirectory
            ? undefined
            : this.createProfileToolRegistry(profile, skillDirectory),
        )
      : undefined)
    const modelDefaults = {
      ...modelRequestDefaultsFromConfig(config, provider),
      ...runtimeOverrides.modelDefaults,
      ...(model ? { model } : {}),
    }

    return new AgentRuntime({
      ...runtimeOverrides,
      profileId: profile,
      modelClient,
      toolsEnabled,
      tools,
      toolAuthorizer,
      skillsEnabled,
      skills: runtimeOverrides.skills ?? this.skill.runtimeSkills(profile),
      skillDirectory,
      skillReviewEveryToolCalls: runtimeOverrides.skillReviewEveryToolCalls
        ?? config.skills.reviewEveryToolCalls,
      runtimeInstructions: runtimeOverrides.runtimeInstructions ?? config.prompt.instructions,
      maxSteps: runtimeOverrides.maxSteps ?? config.runtime.maxSteps,
      maxModelRetries: runtimeOverrides.maxModelRetries ?? config.runtime.maxModelRetries,
      maxConsecutiveToolFailures: runtimeOverrides.maxConsecutiveToolFailures
        ?? config.runtime.maxConsecutiveToolFailures,
      backgroundDelegationEnabled: runtimeOverrides.backgroundDelegationEnabled
        ?? config.delegation.backgroundEnabled,
      subtaskMaxSteps: runtimeOverrides.subtaskMaxSteps ?? config.delegation.subtaskMaxSteps,
      modelDefaults,
      memory: memory === false
        ? undefined
        : memory ?? (config.memory.enabled ? this.createMemoryService(config) : undefined),
      logWriter: runtimeOverrides.logWriter ?? new EkkoFileLogger({
        directory: profileLayout.logDirectory,
        maxBytes: config.logging.maxBytes,
      }),
      logProfile: runtimeOverrides.logProfile ?? profile,
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeConfig()
    this.memory.close()
  }

  private createToolApprovals(config: EkkoConfig): EkkoToolApprovalService {
    return new EkkoToolApprovalService({
      configPath: this.layout.configPath,
      enabled: config.tools.approvals.enabled,
      timeoutMs: config.tools.approvals.timeoutMs,
    })
  }

  private createProfileAgent(profile: string): EkkoProfileAgent {
    this.config.ensureDefaults()
    const profileLayout = this.ensureProfileLayout(profile)
    return new EkkoProfileAgent({
      profile: profileLayout.profile,
      layout: profileLayout,
      directories: this.directories,
      rootDirectory: this.layout.rootDirectory,
      skillsDirectory: this.layout.skillsDirectory,
      logsDirectory: this.layout.logsDirectory,
      workspaceDirectory: this.layout.workspaceDirectory,
      config: this.config,
      database: this.database,
      memoryStore: this.memoryStore,
      memory: this.memory,
      conversations: this.conversations,
      authorization: this.authorizations,
      model: this.model,
      tools: this.tool,
      skills: this.skill,
      toolApprovals: () => this.toolApprovals,
      createRuntime: options => this.createRuntime(options),
    })
  }

  private attachProfileAgent(profileAgent: EkkoProfileAgent): void {
    const profile = profileAgent.profile
    if (profile === 'default' || profile in this) return
    Object.defineProperty(this, profile, {
      configurable: true,
      enumerable: true,
      get: () => this.agent.find(profile),
    })
    this.directProfileProperties.add(profile)
  }

  private detachProfileAgent(profileAgent: EkkoProfileAgent): void {
    if (!this.directProfileProperties.delete(profileAgent.profile)) return
    delete (this as Record<string, unknown>)[profileAgent.profile]
  }

  private createProfileToolRegistry(profile: string, skillDirectory?: string) {
    const config = this.config.read()
    const profileLayout = this.ensureProfile(profile)
    return createDefaultToolRegistry({
      skillDirectory: skillDirectory ?? profileLayout.skillDirectory,
      authorizer: (name, input, context) => this.toolApprovals.authorize(name, input, context),
      executionTimeoutMs: config.tools.executionTimeoutMs,
      codeExec: {
        enabled: config.tools.codeExec.enabled,
        allowedLanguages: config.tools.codeExec.languages,
        timeoutMs: config.tools.codeExec.timeoutMs,
        maxToolCalls: config.tools.codeExec.maxToolCalls,
        maxOutputBytes: config.tools.codeExec.maxOutputBytes,
        maxStderrBytes: config.tools.codeExec.maxStderrBytes,
        maxSourceBytes: config.tools.codeExec.maxSourceBytes,
      },
    })
  }

  private createMemoryService(config: EkkoConfig): MemoryService {
    return new MemoryService({
      store: this.memoryStore,
      enabled: config.memory.enabled,
      recentMessageLimit: config.memory.recentMessageLimit,
      automaticRecallTokenBudget: config.memory.automaticRecallTokenBudget,
      searchResultLimit: config.memory.searchResultLimit,
      reviewEveryUserMessages: config.memory.reviewEveryUserMessages,
    })
  }
}

/**
 * Public all-in-one facade. Namespaced stores remain available for callers
 * that prefer `agent.config`, `agent.authorizations`, or `agent.memory`.
 */
export class EkkoAgent extends EkkoAgentSetup {
  readConfig(): EkkoConfig {
    return this.config.read()
  }

  updateConfig(patch: EkkoConfigPatch): EkkoConfig {
    return this.config.update(patch)
  }

  replaceConfig(config: EkkoConfig): EkkoConfig {
    return this.config.replace(config)
  }

  resetConfig(): EkkoConfig {
    return this.config.reset()
  }

  listModelProviderPresets(): EkkoModelProviderPreset[] {
    return this.config.listModelProviderPresets()
  }

  getModelProviderPreset(id: string): EkkoModelProviderPreset | undefined {
    return this.config.getModelProviderPreset(id)
  }

  setModelProviderPreset(
    id: string,
    preset: Omit<EkkoModelProviderPreset, 'id'> & { id?: string },
  ): EkkoConfig {
    return this.config.setModelProviderPreset(id, preset)
  }

  updateModelProviderPreset(id: string, patch: Partial<EkkoModelProviderPreset>): EkkoConfig {
    return this.config.updateModelProviderPreset(id, patch)
  }

  deleteModelProviderPreset(id: string): boolean {
    return this.config.deleteModelProviderPreset(id)
  }

  installModelProviderPreset(
    id: string,
    options: InstallModelProviderPresetOptions = {},
  ): EkkoConfig {
    return this.config.installModelProviderPreset(id, options)
  }

  listModelProviders(): ConfiguredModelProviderEntry[] {
    return this.config.listModelProviders()
  }

  getModelProvider(id: string): EkkoModelProviderSettings | undefined {
    return this.config.getModelProvider(id)
  }

  setModelProvider(id: string, settings: EkkoModelProviderSettings): EkkoConfig {
    return this.config.setModelProvider(id, settings)
  }

  updateModelProvider(id: string, patch: Partial<EkkoModelProviderSettings>): EkkoConfig {
    return this.config.updateModelProvider(id, patch)
  }

  deleteModelProvider(id: string): boolean {
    return this.config.deleteModelProvider(id)
  }

  setDefaultModel(provider: string, model?: string): EkkoConfig {
    return this.config.setDefaultModel(provider, model)
  }

  listModelAuthorizations(): ConfiguredModelAuthorizationEntry[] {
    return this.config.listModelAuthorizations()
  }

  getModelAuthorization(provider: string): EkkoModelAuthorizationSettings | undefined {
    return this.authorizations.get(provider)
  }

  setModelAuthorization(provider: string, settings: EkkoModelAuthorizationSettings): EkkoConfig {
    return this.authorizations.set(provider, settings)
  }

  updateModelAuthorization(
    provider: string,
    patch: Partial<EkkoModelAuthorizationSettings>,
  ): EkkoConfig {
    return this.authorizations.update(provider, patch)
  }

  deleteModelAuthorization(provider: string): boolean {
    return this.authorizations.delete(provider)
  }

  modelAuthorizationNeedsRefresh(provider: string): boolean {
    return this.authorizations.needsRefresh(provider)
  }

  refreshModelAuthorization(
    provider: string,
    model?: string,
  ): Promise<EkkoModelAuthorizationCredentials> {
    return this.authorizations.refresh(provider, model)
  }

  resolveModelAuthorization(
    provider: string,
    model?: string,
  ): Promise<EkkoModelAuthorizationCredentials> {
    return this.authorizations.resolve(provider, model)
  }
}

export function setupEkkoAgent(options: SetupEkkoAgentOptions = {}): EkkoAgent {
  return new EkkoAgent(options)
}
