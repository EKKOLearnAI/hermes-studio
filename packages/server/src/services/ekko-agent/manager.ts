import {
  AgentRuntime,
  type AgentRuntimeRunInput,
  type AgentRuntimeRunResult,
} from '../../../../ekko-agent/src'

export class GlobalEkkoAgent {
  readonly createdAt = Date.now()
  lastUsedAt = this.createdAt
  runCount = 0
  private readonly runtime = new AgentRuntime({})

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    this.lastUsedAt = Date.now()
    this.runCount += 1
    return this.runtime.run(input)
  }

  status() {
    return {
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      runCount: this.runCount,
    }
  }
}

const globalEkkoAgent = new GlobalEkkoAgent()

export function getGlobalEkkoAgent(): GlobalEkkoAgent {
  return globalEkkoAgent
}
