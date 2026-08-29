import type { EkkoConversationStore } from '../conversations/store'
import type { EkkoDirectoryManager } from '../directories'
import type {
  AddEkkoMessageInput,
  CreateEkkoSessionInput,
  EkkoMessage,
  EkkoSession,
  EkkoSessionDetail,
  EkkoSessionUsageUpdate,
  ListEkkoMessagesInput,
  ListEkkoSessionsInput,
  UpdateEkkoMessageInput,
  UpdateEkkoSessionInput,
} from '../conversations/types'
import type { EkkoLogEntry, EkkoLogQuery, EkkoLogRecord } from '../logging/file-logger'
import { EkkoFileLogger } from '../logging/file-logger'
import type { MemoryCaptureMessage, MemoryService } from '../memory/service'
import type {
  MemoryAuditEvent,
  MemoryAuditQuery,
  MemoryContext,
  MemoryCreateInput,
  MemoryDeleteInput,
  MemoryExpireInput,
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryMessage,
  MemoryMessageListInput,
  MemoryNode,
  MemoryProposeUpdateInput,
  MemoryProposeUpdateResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryRuntimeIdentity,
  MemorySessionState,
  MemorySummary,
  MemoryUpdateInput,
} from '../memory/types'
import type { AgentRuntime } from '../runtime/runtime'
import type { CreateEkkoRuntimeOptions } from '../setup'
import type {
  EkkoSkillCreateInput,
  EkkoSkillEditInput,
  EkkoSkillManager,
  EkkoSkillOperationOptions,
  EkkoSkillPatchInput,
  EkkoSkillSupportFileInput,
} from '../skills/manager'
import type { AgentSkill } from '../skills/types'
import type { SkillManageInput } from '../tools/skills'
import type { EkkoToolManager } from '../tools/manager'
import type { AgentToolRegistry } from '../tools/registry'
import type {
  AgentTool,
  AgentToolContext,
  AgentToolProvider,
  AgentToolResult,
} from '../tools/types'

export type EkkoProfileRuntimeOptions = Omit<CreateEkkoRuntimeOptions, 'profile'>
export type EkkoProfileSkillOperationOptions = Omit<EkkoSkillOperationOptions, 'profile'>
export type EkkoProfileSkillCreateInput = Omit<EkkoSkillCreateInput, 'profile'>
export type EkkoProfileSkillEditInput = Omit<EkkoSkillEditInput, 'profile'>
export type EkkoProfileSkillPatchInput = Omit<EkkoSkillPatchInput, 'profile'>
export type EkkoProfileSkillSupportFileInput = Omit<EkkoSkillSupportFileInput, 'profile'>
export type EkkoProfileMemoryIdentity = Omit<MemoryRuntimeIdentity, 'profileId'>
export type EkkoProfileMemoryQuery = Omit<MemoryQuery, 'profileId'>
export type EkkoProfileMemoryAuditQuery = Omit<MemoryAuditQuery, 'profileId'>
export type EkkoProfileMemoryCreateInput = ProfileMemoryInput<MemoryCreateInput>
export type EkkoProfileMemoryUpdateInput = ProfileMemoryInput<MemoryUpdateInput>
export type EkkoProfileMemoryExpireInput = ProfileMemoryInput<MemoryExpireInput>
export type EkkoProfileMemoryDeleteInput = ProfileMemoryInput<MemoryDeleteInput>
export type EkkoProfileMemoryForgetInput = ProfileMemoryInput<MemoryForgetInput>
export type EkkoProfileMemoryProposeUpdateInput = ProfileMemoryInput<MemoryProposeUpdateInput>

type ProfileMemoryInput<T extends { identity?: Partial<MemoryRuntimeIdentity> }> =
  Omit<T, 'identity'> & { identity?: Omit<Partial<MemoryRuntimeIdentity>, 'profileId'> }

/** Profile-bound filesystem locations exposed by `ekko.<profile>.directory`. */
export class EkkoProfileDirectoryManager {
  readonly skillDirectory: string
  readonly logDirectory: string
  readonly workspaceDirectory: string

  constructor(
    readonly profile: string,
    private readonly directories: EkkoDirectoryManager,
  ) {
    this.skillDirectory = directories.profileSkillsDirectory(profile)
    this.logDirectory = directories.profileLogsDirectory(profile)
    this.workspaceDirectory = directories.profileWorkspaceDirectory(profile)
  }

  sessionWorkspaceDirectory(sessionId: string): string {
    return this.directories.sessionWorkspaceDirectory(this.profile, sessionId)
  }
}

/** Profile-bound tool operations exposed by `ekko.<profile>.tool`. */
export class EkkoProfileToolManager {
  constructor(
    readonly profile: string,
    private readonly tools: EkkoToolManager,
  ) {}

  registry(): AgentToolRegistry {
    return this.tools.registry(this.profile)
  }

  createRuntimeRegistry(): AgentToolRegistry {
    return this.tools.createRuntimeRegistry(this.profile)
  }

  definitions() {
    return this.tools.definitions(this.profile)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name, this.profile)
  }

  register(tool: AgentTool): void {
    this.tools.register(tool, this.profile)
  }

  registerMany(tools: AgentTool[]): void {
    this.tools.registerMany(tools, this.profile)
  }

  unregister(name: string): boolean {
    return this.tools.unregister(name, this.profile)
  }

  registerProvider(provider: AgentToolProvider): void {
    this.tools.registerProvider(provider, this.profile)
  }

  unregisterProvider(providerId: string): boolean {
    return this.tools.unregisterProvider(providerId, this.profile)
  }

  refresh(context?: AgentToolContext): Promise<void> {
    return this.tools.refresh(profileContext(this.profile, context), this.profile)
  }

  execute(
    name: string,
    input: Record<string, unknown>,
    context?: AgentToolContext,
  ): Promise<AgentToolResult> {
    return this.tools.execute(name, input, profileContext(this.profile, context), this.profile)
  }
}

/** Profile-bound skill operations exposed by `ekko.<profile>.skill`. */
export class EkkoProfileSkillManager {
  constructor(
    readonly profile: string,
    private readonly skills: EkkoSkillManager,
  ) {}

  register(skill: AgentSkill): void {
    this.skills.register(skill, this.profile)
  }

  registerMany(skills: AgentSkill[]): void {
    this.skills.registerMany(skills, this.profile)
  }

  unregister(id: string): boolean {
    return this.skills.unregister(id, this.profile)
  }

  get(id: string): AgentSkill | undefined {
    return this.skills.get(id, this.profile)
  }

  registered(): AgentSkill[] {
    return this.skills.registered(this.profile)
  }

  discover(query = '', options: EkkoProfileSkillOperationOptions = {}): Promise<AgentToolResult> {
    return this.skills.discover(query, { ...options, profile: this.profile })
  }

  view(
    name: string,
    filePath?: string,
    options: EkkoProfileSkillOperationOptions = {},
  ): Promise<AgentToolResult> {
    return this.skills.view(name, filePath, { ...options, profile: this.profile })
  }

  create(input: EkkoProfileSkillCreateInput): Promise<AgentToolResult> {
    return this.skills.create({ ...input, profile: this.profile })
  }

  edit(input: EkkoProfileSkillEditInput): Promise<AgentToolResult> {
    return this.skills.edit({ ...input, profile: this.profile })
  }

  patch(input: EkkoProfileSkillPatchInput): Promise<AgentToolResult> {
    return this.skills.patch({ ...input, profile: this.profile })
  }

  delete(
    name: string,
    options: EkkoProfileSkillOperationOptions & { confirmed: boolean },
  ): Promise<AgentToolResult> {
    return this.skills.delete(name, { ...options, profile: this.profile })
  }

  writeFile(
    input: EkkoProfileSkillSupportFileInput & { fileContent: string },
  ): Promise<AgentToolResult> {
    return this.skills.writeFile({ ...input, profile: this.profile })
  }

  removeFile(input: EkkoProfileSkillSupportFileInput): Promise<AgentToolResult> {
    return this.skills.removeFile({ ...input, profile: this.profile })
  }

  manage(
    input: SkillManageInput,
    options: EkkoProfileSkillOperationOptions = {},
  ): Promise<AgentToolResult> {
    return this.skills.manage(input, { ...options, profile: this.profile })
  }

  runtimeSkills(): AgentSkill[] {
    return this.skills.runtimeSkills(this.profile)
  }
}

/** Profile-bound runtime factory exposed by `ekko.<profile>.runtime`. */
export class EkkoProfileRuntimeManager {
  constructor(
    readonly profile: string,
    private readonly createRuntime: (options?: CreateEkkoRuntimeOptions) => AgentRuntime,
  ) {}

  create(options: EkkoProfileRuntimeOptions = {}): AgentRuntime {
    return this.createRuntime({ ...options, profile: this.profile })
  }
}

/** Profile-isolated memory operations exposed by `ekko.<profile>.memory`. */
export class EkkoProfileMemoryManager {
  constructor(
    readonly profile: string,
    private readonly memory: MemoryService,
  ) {}

  get isEnabled(): boolean {
    return this.memory.isEnabled
  }

  captureMessages(
    identity: EkkoProfileMemoryIdentity,
    messages: MemoryCaptureMessage[],
  ): Promise<string[]> {
    return this.memory.captureMessages(this.identity(identity), messages)
  }

  retrieve(
    identity: EkkoProfileMemoryIdentity,
    queryText?: string,
    overrides: EkkoProfileMemoryQuery = {},
  ): Promise<MemoryContext> {
    return this.memory.retrieve(this.identity(identity), queryText, this.query(overrides))
  }

  search(
    identity: EkkoProfileMemoryIdentity,
    query: EkkoProfileMemoryQuery,
  ): Promise<MemoryQueryResult> {
    return this.memory.search(this.identity(identity), this.query(query))
  }

  get(id: string, identity?: Partial<EkkoProfileMemoryIdentity>): Promise<MemoryNode | undefined> {
    return this.memory.get(id, this.identity(identity))
  }

  list(query: EkkoProfileMemoryQuery = {}): Promise<MemoryNode[]> {
    return this.memory.list(this.query(query))
  }

  create(input: EkkoProfileMemoryCreateInput): Promise<MemoryProposeUpdateResult> {
    return this.memory.create(this.input(input))
  }

  update(id: string, input: EkkoProfileMemoryUpdateInput): Promise<MemoryProposeUpdateResult> {
    return this.memory.update(id, this.input(input))
  }

  expire(id: string, input: EkkoProfileMemoryExpireInput): Promise<MemoryProposeUpdateResult> {
    return this.memory.expire(id, this.input(input))
  }

  delete(id: string, input: EkkoProfileMemoryDeleteInput): Promise<MemoryForgetResult> {
    return this.memory.delete(id, this.input(input))
  }

  listMessages(input: MemoryMessageListInput): Promise<MemoryMessage[]> {
    return this.memory.listMessages(input)
  }

  getLatestSummary(sessionId: string): Promise<MemorySummary | undefined> {
    return this.memory.getLatestSummary(sessionId)
  }

  getSessionState(sessionId: string): Promise<MemorySessionState | undefined> {
    return this.memory.getSessionState(sessionId)
  }

  listAuditEvents(query: EkkoProfileMemoryAuditQuery = {}): Promise<MemoryAuditEvent[]> {
    return this.memory.listAuditEvents({ ...query, profileId: this.profile })
  }

  proposeUpdate(input: EkkoProfileMemoryProposeUpdateInput): Promise<MemoryProposeUpdateResult> {
    return this.memory.proposeUpdate(this.input(input))
  }

  forget(input: EkkoProfileMemoryForgetInput): Promise<MemoryForgetResult> {
    return this.memory.forget(this.input(input))
  }

  scheduleExtraction(identity: EkkoProfileMemoryIdentity): void {
    this.memory.scheduleExtraction(this.identity(identity))
  }

  scheduleRunCompletion(
    identity: EkkoProfileMemoryIdentity,
    messages: MemoryCaptureMessage[],
  ): void {
    this.memory.scheduleRunCompletion(this.identity(identity), messages)
  }

  drain(): Promise<void> {
    return this.memory.drain()
  }

  contextPrompt(context: MemoryContext): string {
    return this.memory.contextPrompt(context)
  }

  private identity(identity: Partial<EkkoProfileMemoryIdentity> = {}): MemoryRuntimeIdentity {
    return { ...identity, profileId: this.profile } as MemoryRuntimeIdentity
  }

  private query(query: EkkoProfileMemoryQuery): MemoryQuery {
    return { ...query, profileId: this.profile }
  }

  private input<T extends { identity?: Omit<Partial<MemoryRuntimeIdentity>, 'profileId'> }>(input: T): T & {
    identity: Partial<MemoryRuntimeIdentity>
  } {
    return { ...input, identity: this.identity(input.identity) }
  }
}

/** Profile-isolated session and message operations exposed by `ekko.<profile>.conversation`. */
export class EkkoProfileConversationManager {
  constructor(
    readonly profile: string,
    private readonly conversations: EkkoConversationStore,
  ) {}

  createSession(input: Omit<CreateEkkoSessionInput, 'profile'> = {}): EkkoSession {
    return this.conversations.createSession({ ...input, profile: this.profile })
  }

  getSession(id: string): EkkoSession | null {
    return this.ownedSession(id)
  }

  listSessions(input: Omit<ListEkkoSessionsInput, 'profile'> = {}): EkkoSession[] {
    return this.conversations.listSessions({ ...input, profile: this.profile })
  }

  updateSession(id: string, patch: UpdateEkkoSessionInput): EkkoSession | null {
    return this.ownedSession(id) ? this.conversations.updateSession(id, patch) : null
  }

  renameSession(id: string, title: string | null): EkkoSession | null {
    return this.ownedSession(id) ? this.conversations.renameSession(id, title) : null
  }

  setSessionArchived(id: string, archived: boolean): EkkoSession | null {
    return this.ownedSession(id) ? this.conversations.setSessionArchived(id, archived) : null
  }

  endSession(id: string, reason = 'completed', endedAt?: number): EkkoSession | null {
    return this.ownedSession(id) ? this.conversations.endSession(id, reason, endedAt) : null
  }

  reopenSession(id: string): EkkoSession | null {
    return this.ownedSession(id) ? this.conversations.reopenSession(id) : null
  }

  deleteSession(id: string): boolean {
    return this.ownedSession(id) ? this.conversations.deleteSession(id) : false
  }

  getSessionDetail(id: string, messages: ListEkkoMessagesInput = {}): EkkoSessionDetail | null {
    return this.ownedSession(id) ? this.conversations.getSessionDetail(id, messages) : null
  }

  addMessage(input: AddEkkoMessageInput): EkkoMessage {
    this.requireSession(input.sessionId)
    return this.conversations.addMessage(input)
  }

  addMessages(inputs: AddEkkoMessageInput[]): EkkoMessage[] {
    for (const input of inputs) this.requireSession(input.sessionId)
    return this.conversations.addMessages(inputs)
  }

  getMessage(id: number): EkkoMessage | null {
    const message = this.conversations.getMessage(id)
    return message && this.ownedSession(message.sessionId) ? message : null
  }

  listMessages(sessionId: string, input: ListEkkoMessagesInput = {}): EkkoMessage[] {
    return this.ownedSession(sessionId) ? this.conversations.listMessages(sessionId, input) : []
  }

  updateMessage(id: number, patch: UpdateEkkoMessageInput): EkkoMessage | null {
    return this.getMessage(id) ? this.conversations.updateMessage(id, patch) : null
  }

  deleteMessage(id: number): boolean {
    return this.getMessage(id) ? this.conversations.deleteMessage(id) : false
  }

  clearMessages(sessionId: string): number {
    return this.ownedSession(sessionId) ? this.conversations.clearMessages(sessionId) : 0
  }

  recordSessionUsage(sessionId: string, usage: EkkoSessionUsageUpdate): EkkoSession | null {
    return this.ownedSession(sessionId)
      ? this.conversations.recordSessionUsage(sessionId, usage)
      : null
  }

  private ownedSession(id: string): EkkoSession | null {
    const session = this.conversations.getSession(id)
    return session?.profile === this.profile ? session : null
  }

  private requireSession(id: string): EkkoSession {
    const session = this.ownedSession(id)
    if (!session) throw new Error(`Ekko session is not owned by profile ${this.profile}: ${id}`)
    return session
  }
}

/** Profile-bound structured log reader/writer exposed by `ekko.<profile>.log`. */
export class EkkoProfileLogManager {
  readonly filePath: string
  readonly maxBytes: number

  constructor(
    readonly profile: string,
    private readonly logger: EkkoFileLogger,
  ) {
    this.filePath = logger.filePath
    this.maxBytes = logger.maxBytes
  }

  write(entry: Omit<EkkoLogEntry, 'profile'>): boolean {
    return this.logger.write({ ...entry, profile: this.profile })
  }

  query(query: EkkoLogQuery = {}): EkkoLogRecord[] {
    return this.logger.query(query)
  }
}

function profileContext(profile: string, context?: AgentToolContext): AgentToolContext {
  return { ...context, profileId: profile }
}
