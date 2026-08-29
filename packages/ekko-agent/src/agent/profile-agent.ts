import { statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { EkkoConfigStore } from '../config-store'
import type { EkkoConversationStore } from '../conversations/store'
import type { EkkoDatabaseManager } from '../database'
import type { EkkoDirectoryManager } from '../directories'
import type { EkkoModelAuthorizationManager } from '../model/authorization'
import type { EkkoModelManager } from '../model/manager'
import type { MemoryService } from '../memory/service'
import type { SqliteMemoryStore } from '../memory/store'
import type { AgentRuntime } from '../runtime/runtime'
import type { CreateEkkoRuntimeOptions, EkkoProfileDirectoryLayout } from '../setup'
import type { EkkoSkillManager } from '../skills/manager'
import type { EkkoToolApprovalService } from '../tools/approval'
import type { EkkoToolManager } from '../tools/manager'
import { EkkoFileLogger } from '../logging/file-logger'
import {
  EkkoProfileConversationManager,
  EkkoProfileDirectoryManager,
  EkkoProfileLogManager,
  EkkoProfileMemoryManager,
  EkkoProfileRuntimeManager,
  EkkoProfileSkillManager,
  EkkoProfileToolManager,
} from './modules'

export interface EkkoProfileAgentOptions {
  profile: string
  layout: EkkoProfileDirectoryLayout
  directories: EkkoDirectoryManager
  rootDirectory: string
  skillsDirectory: string
  logsDirectory: string
  workspaceDirectory: string
  config: EkkoConfigStore
  database: EkkoDatabaseManager
  memoryStore: SqliteMemoryStore
  memory: MemoryService
  conversations: EkkoConversationStore
  authorization: EkkoModelAuthorizationManager
  model: EkkoModelManager
  tools: EkkoToolManager
  skills: EkkoSkillManager
  toolApprovals: () => EkkoToolApprovalService
  createRuntime: (options?: CreateEkkoRuntimeOptions) => AgentRuntime
}

export interface EkkoProfileAgentValidation {
  profile: string
  configSchemaVersion: number
  directories: {
    skill: string
    log: string
    workspace: string
  }
}

/** One independent module facade bound to exactly one Ekko profile. */
export class EkkoProfileAgent {
  readonly id: string
  readonly name: string
  readonly profile: string
  readonly layout: EkkoProfileDirectoryLayout
  readonly validation: EkkoProfileAgentValidation
  readonly directory: EkkoProfileDirectoryManager
  readonly directories: EkkoProfileDirectoryManager
  readonly config: EkkoConfigStore
  readonly database: EkkoDatabaseManager
  readonly memoryStore: SqliteMemoryStore
  readonly authorization: EkkoModelAuthorizationManager
  readonly authorizations: EkkoModelAuthorizationManager
  readonly model: EkkoModelManager
  readonly tool: EkkoProfileToolManager
  readonly skill: EkkoProfileSkillManager
  readonly memory: EkkoProfileMemoryManager
  readonly conversation: EkkoProfileConversationManager
  readonly conversations: EkkoProfileConversationManager
  readonly runtime: EkkoProfileRuntimeManager
  readonly log: EkkoProfileLogManager
  readonly logger: EkkoProfileLogManager
  private readonly getToolApprovals: () => EkkoToolApprovalService

  constructor(options: EkkoProfileAgentOptions) {
    const config = options.config.ensureDefaults()
    this.validation = validateProfileAgent(options, config.schemaVersion)
    this.id = options.profile
    this.name = options.profile
    this.profile = options.profile
    this.layout = options.layout
    this.directory = new EkkoProfileDirectoryManager(this.profile, options.directories)
    this.directories = this.directory
    this.config = options.config
    this.database = options.database
    this.memoryStore = options.memoryStore
    this.authorization = options.authorization
    this.authorizations = options.authorization
    this.model = options.model
    this.tool = new EkkoProfileToolManager(this.profile, options.tools)
    this.skill = new EkkoProfileSkillManager(this.profile, options.skills)
    this.memory = new EkkoProfileMemoryManager(this.profile, options.memory)
    this.conversation = new EkkoProfileConversationManager(this.profile, options.conversations)
    this.conversations = this.conversation
    this.runtime = new EkkoProfileRuntimeManager(this.profile, options.createRuntime)
    const logConfig = config.logging
    this.log = new EkkoProfileLogManager(this.profile, new EkkoFileLogger({
      directory: options.layout.logDirectory,
      maxBytes: logConfig.maxBytes,
    }))
    this.logger = this.log
    this.getToolApprovals = options.toolApprovals
  }

  get toolApprovals(): EkkoToolApprovalService {
    return this.getToolApprovals()
  }

  createRuntime(options: Omit<CreateEkkoRuntimeOptions, 'profile'> = {}): AgentRuntime {
    return this.runtime.create(options)
  }
}

function validateProfileAgent(
  options: EkkoProfileAgentOptions,
  configSchemaVersion: number,
): EkkoProfileAgentValidation {
  if (options.layout.profile !== options.profile) {
    throw new Error(`Ekko profile layout mismatch: ${options.profile} != ${options.layout.profile}`)
  }
  assertManagedDirectory('skill', options.layout.skillDirectory, options.skillsDirectory)
  assertManagedDirectory('log', options.layout.logDirectory, options.logsDirectory)
  assertManagedDirectory('workspace', options.layout.workspaceDirectory, options.workspaceDirectory)
  assertInsideRoot(options.layout.skillDirectory, options.rootDirectory)
  assertInsideRoot(options.layout.logDirectory, options.rootDirectory)
  assertInsideRoot(options.layout.workspaceDirectory, options.rootDirectory)
  return {
    profile: options.profile,
    configSchemaVersion,
    directories: {
      skill: options.layout.skillDirectory,
      log: options.layout.logDirectory,
      workspace: options.layout.workspaceDirectory,
    },
  }
}

function assertManagedDirectory(kind: string, path: string, parent: string): void {
  assertInsideRoot(path, parent)
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    // The message below is deliberately stable for host diagnostics.
  }
  if (!isDirectory) throw new Error(`Ekko profile ${kind} directory is not usable: ${path}`)
}

function assertInsideRoot(path: string, root: string): void {
  const child = resolve(path)
  const parent = resolve(root)
  const offset = relative(parent, child)
  if (!offset || offset.startsWith('..') || resolve(parent, offset) !== child) {
    throw new Error(`Ekko profile directory is outside its managed root: ${path}`)
  }
}
