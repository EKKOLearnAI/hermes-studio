import { AgentToolRegistry } from './registry'
import type {
  AgentTool,
  AgentToolContext,
  AgentToolProvider,
  AgentToolResult,
} from './types'

export interface EkkoToolManagerOptions {
  createRegistry: (profile: string) => AgentToolRegistry
}

/** Public tool module used by `ekko.tool` and newly created runtimes. */
export class EkkoToolManager {
  private readonly createRegistry: (profile: string) => AgentToolRegistry
  private readonly directRegistries = new Map<string, AgentToolRegistry>()
  private readonly registeredTools = new Map<string, Map<string, AgentTool>>()
  private readonly removedTools = new Map<string, Set<string>>()
  private readonly registeredProviders = new Map<string, Map<string, AgentToolProvider>>()
  private readonly removedProviders = new Map<string, Set<string>>()

  constructor(options: EkkoToolManagerOptions) {
    this.createRegistry = options.createRegistry
  }

  registry(profile = 'default'): AgentToolRegistry {
    const key = normalizeProfile(profile)
    let registry = this.directRegistries.get(key)
    if (!registry) {
      registry = this.buildRegistry(key)
      this.directRegistries.set(key, registry)
    }
    return registry
  }

  /** A fresh registry for one runtime, including all module registrations. */
  createRuntimeRegistry(profile = 'default', baseRegistry?: AgentToolRegistry): AgentToolRegistry {
    return this.buildRegistry(normalizeProfile(profile), baseRegistry)
  }

  definitions(profile = 'default') {
    return this.registry(profile).definitions()
  }

  get(name: string, profile = 'default'): AgentTool | undefined {
    return this.registry(profile).get(name)
  }

  register(tool: AgentTool, profile = 'default'): void {
    const key = normalizeProfile(profile)
    let tools = this.registeredTools.get(key)
    if (!tools) {
      tools = new Map()
      this.registeredTools.set(key, tools)
    }
    tools.set(tool.definition.name, tool)
    this.removedTools.get(key)?.delete(tool.definition.name)
    this.directRegistries.get(key)?.register(tool)
  }

  registerMany(tools: AgentTool[], profile = 'default'): void {
    for (const tool of tools) this.register(tool, profile)
  }

  unregister(name: string, profile = 'default'): boolean {
    const key = normalizeProfile(profile)
    const existed = !!this.registry(key).get(name)
    this.registeredTools.get(key)?.delete(name)
    let removed = this.removedTools.get(key)
    if (!removed) {
      removed = new Set()
      this.removedTools.set(key, removed)
    }
    removed.add(name)
    this.directRegistries.get(key)?.unregister(name)
    return existed
  }

  registerProvider(provider: AgentToolProvider, profile = 'default'): void {
    const key = normalizeProfile(profile)
    let providers = this.registeredProviders.get(key)
    if (!providers) {
      providers = new Map()
      this.registeredProviders.set(key, providers)
    }
    providers.set(provider.id, provider)
    this.removedProviders.get(key)?.delete(provider.id)
    this.directRegistries.get(key)?.registerProvider(provider)
  }

  unregisterProvider(providerId: string, profile = 'default'): boolean {
    const key = normalizeProfile(profile)
    const registry = this.registry(key)
    const removedFromRegistry = registry.unregisterProvider(providerId)
    const removedRegistration = this.registeredProviders.get(key)?.delete(providerId) ?? false
    let removed = this.removedProviders.get(key)
    if (!removed) {
      removed = new Set()
      this.removedProviders.set(key, removed)
    }
    removed.add(providerId)
    return removedFromRegistry || removedRegistration
  }

  refresh(context?: AgentToolContext, profile = 'default'): Promise<void> {
    return this.registry(profile).refreshTools(context)
  }

  /** Drop cached direct registries after Profile configuration changes. */
  invalidate(profile?: string): void {
    if (profile) this.directRegistries.delete(normalizeProfile(profile))
    else this.directRegistries.clear()
  }

  execute(
    name: string,
    input: Record<string, unknown>,
    context?: AgentToolContext,
    profile = 'default',
  ): Promise<AgentToolResult> {
    return this.registry(profile).execute(name, input, context)
  }

  private buildRegistry(profile: string, baseRegistry?: AgentToolRegistry): AgentToolRegistry {
    const registry = baseRegistry ?? this.createRegistry(profile)
    for (const providerId of this.removedProviders.get(profile) || []) {
      registry.unregisterProvider(providerId)
    }
    for (const provider of this.registeredProviders.get(profile)?.values() || []) {
      registry.registerProvider(provider)
    }
    for (const name of this.removedTools.get(profile) || []) registry.unregister(name)
    for (const tool of this.registeredTools.get(profile)?.values() || []) registry.register(tool)
    return registry
  }
}

function normalizeProfile(profile: string): string {
  return String(profile || '').trim() || 'default'
}
