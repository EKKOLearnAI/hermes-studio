import type { AgentTool, AgentToolContext, AgentToolProvider, AgentToolResult } from './types'
import { createBrowserTools } from './browser'
import { createFileTools } from './files'
import { createMcpToolProvider } from './mcp'
import { createTerminalTools } from './terminal'

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool>()
  private readonly providers = new Map<string, AgentToolProvider>()
  private readonly providerTools = new Map<string, Set<string>>()

  register(tool: AgentTool): void {
    this.tools.set(tool.definition.name, tool)
  }

  registerMany(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  registerProvider(provider: AgentToolProvider): void {
    this.providers.set(provider.id, provider)
  }

  unregisterProvider(providerId: string): boolean {
    return this.providers.delete(providerId)
  }

  async refreshTools(context?: AgentToolContext): Promise<void> {
    for (const provider of this.providers.values()) {
      const previous = this.providerTools.get(provider.id)
      if (previous) {
        for (const name of previous) {
          this.tools.delete(name)
        }
      }
      const tools = await provider.listTools(context)
      this.registerMany(tools)
      this.providerTools.set(provider.id, new Set(tools.map(tool => tool.definition.name)))
    }
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  definitions() {
    return [...this.tools.values()].map(tool => tool.definition)
  }

  async execute(name: string, input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        ok: false,
        content: `Unknown tool: ${name}`,
        error: `Unknown tool: ${name}`,
      }
    }
    return tool.execute(input, context)
  }
}

export function createDefaultToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry()
  for (const tool of [...createFileTools(), ...createTerminalTools(), ...createBrowserTools()]) {
    registry.register(tool)
  }
  registry.registerProvider(createMcpToolProvider())
  return registry
}
