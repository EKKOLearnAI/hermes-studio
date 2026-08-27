import type { EkkoProfileAgent } from './profile-agent'

export interface EkkoAgentManagerOptions {
  create: (profile: string) => EkkoProfileAgent
  onCreate?: (agent: EkkoProfileAgent) => void
  onRemove?: (agent: EkkoProfileAgent) => void
}

/** Owns the one-profile-to-one-agent instance map for an Ekko installation. */
export class EkkoAgentManager {
  private readonly agents = new Map<string, EkkoProfileAgent>()

  constructor(private readonly options: EkkoAgentManagerOptions) {}

  create(profile: string): EkkoProfileAgent {
    const name = normalizeAgentProfile(profile)
    if (this.agents.has(name)) throw new Error(`Ekko profile agent already exists: ${name}`)
    return this.instantiate(name)
  }

  ensure(profile = 'default'): EkkoProfileAgent {
    const name = normalizeAgentProfile(profile)
    return this.agents.get(name) ?? this.instantiate(name)
  }

  get(profile = 'default'): EkkoProfileAgent {
    const name = normalizeAgentProfile(profile)
    const agent = this.agents.get(name)
    if (!agent) throw new Error(`Ekko profile agent is not set up: ${name}`)
    return agent
  }

  find(profile: string): EkkoProfileAgent | undefined {
    return this.agents.get(normalizeAgentProfile(profile))
  }

  has(profile: string): boolean {
    return this.agents.has(normalizeAgentProfile(profile))
  }

  list(): EkkoProfileAgent[] {
    return [...this.agents.values()]
  }

  names(): string[] {
    return [...this.agents.keys()]
  }

  remove(profile: string): boolean {
    const name = normalizeAgentProfile(profile)
    if (name === 'default') throw new Error('The default Ekko profile agent cannot be removed.')
    const agent = this.agents.get(name)
    if (!agent) return false
    this.agents.delete(name)
    this.options.onRemove?.(agent)
    return true
  }

  private instantiate(profile: string): EkkoProfileAgent {
    const agent = this.options.create(profile)
    this.agents.set(profile, agent)
    try {
      this.options.onCreate?.(agent)
    } catch (error) {
      this.agents.delete(profile)
      throw error
    }
    return agent
  }
}

export function normalizeAgentProfile(profile: string): string {
  return String(profile || '').trim() || 'default'
}
