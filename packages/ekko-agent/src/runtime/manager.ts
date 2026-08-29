import type { AgentRuntime } from './runtime'
import type { CreateEkkoRuntimeOptions } from '../setup'

export interface EkkoRuntimeManagerOptions {
  create: (options?: CreateEkkoRuntimeOptions) => AgentRuntime
}

/** Public runtime module used through `ekko.runtime`. */
export class EkkoRuntimeManager {
  private readonly createRuntime: EkkoRuntimeManagerOptions['create']

  constructor(options: EkkoRuntimeManagerOptions) {
    this.createRuntime = options.create
  }

  create(options: CreateEkkoRuntimeOptions = {}): AgentRuntime {
    return this.createRuntime(options)
  }
}
