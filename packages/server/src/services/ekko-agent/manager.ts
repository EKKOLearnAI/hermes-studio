import {
  AgentRuntime,
  EkkoDatabaseManager,
  MemoryService,
  SqliteMemoryStore,
  type AgentRuntimeRunInput,
  type AgentRuntimeRunResult,
} from '../../../../ekko-agent/src'
import { resolve } from 'node:path'
import { config } from '../../config'
import { logger } from '../logger'

export interface GlobalEkkoAgentOptions {
  webUiHome?: string
  memory?: MemoryService | false
  skillDirectory?: string
}

export class GlobalEkkoAgent {
  readonly createdAt = Date.now()
  lastUsedAt = this.createdAt
  runCount = 0
  private readonly options: GlobalEkkoAgentOptions
  private runtime?: AgentRuntime
  private memory?: MemoryService
  private memoryDatabasePath?: string

  constructor(options: GlobalEkkoAgentOptions = {}) {
    this.options = options
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    this.lastUsedAt = Date.now()
    this.runCount += 1
    return this.runtimeInstance().run(input)
  }

  close(): void {
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
      skillDirectory: this.options.skillDirectory,
    }
  }

  private runtimeInstance(): AgentRuntime {
    if (this.runtime) return this.runtime
    if (this.options.memory === false) {
      this.runtime = new AgentRuntime({ skillDirectory: this.options.skillDirectory })
      return this.runtime
    }
    if (this.options.memory) {
      this.memory = this.options.memory
    } else {
      try {
        const database = new EkkoDatabaseManager({ webUiHome: this.options.webUiHome })
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
      skillDirectory: this.options.skillDirectory,
    })
    return this.runtime
  }
}

export function createGlobalEkkoAgent(
  options: GlobalEkkoAgentOptions = {},
  env: Record<string, string | undefined> = process.env,
): GlobalEkkoAgent {
  return new GlobalEkkoAgent({
    ...options,
    memory: env.NODE_ENV === 'production' ? false : options.memory,
  })
}

const globalEkkoAgents = new Map<string, GlobalEkkoAgent>()

export function getGlobalEkkoAgent(skillDirectory?: string): GlobalEkkoAgent {
  const normalizedDirectory = skillDirectory ? resolve(skillDirectory) : ''
  let agent = globalEkkoAgents.get(normalizedDirectory)
  if (!agent) {
    agent = createGlobalEkkoAgent({
      webUiHome: config.appHome,
      skillDirectory: normalizedDirectory || undefined,
    })
    globalEkkoAgents.set(normalizedDirectory, agent)
  }
  return agent
}
