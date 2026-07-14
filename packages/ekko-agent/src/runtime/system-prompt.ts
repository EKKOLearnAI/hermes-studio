import type { AgentSkill } from '../skills/types'

export interface SystemPromptInput {
  basePrompt?: string
  runtimeInstructions?: string[]
  userSystemMessages?: string[]
  skills?: AgentSkill[]
  memoryContext?: string
  context?: {
    provider?: string
    model?: string
    cwd?: string
    workspaceRoot?: string
  }
}

const DEFAULT_BASE_PROMPT = 'You are Ekko Agent, a pragmatic AI agent that can reason, use tools, and return concise results.'

export function buildSystemPrompt(input: SystemPromptInput = {}): string {
  const sections: string[] = []
  sections.push(input.basePrompt?.trim() || DEFAULT_BASE_PROMPT)

  if (input.runtimeInstructions?.length) {
    sections.push(section('Runtime Instructions', input.runtimeInstructions.filter(Boolean).join('\n')))
  }

  if (input.context?.provider || input.context?.model || input.context?.workspaceRoot || input.context?.cwd) {
    const lines = [
      input.context.provider ? `provider: ${input.context.provider}` : '',
      input.context.model ? `model: ${input.context.model}` : '',
      input.context.workspaceRoot ? `workspaceRoot: ${input.context.workspaceRoot}` : '',
      input.context.cwd ? `cwd: ${input.context.cwd}` : '',
    ].filter(Boolean)
    sections.push(section('Runtime Context', lines.join('\n')))
  }

  if (input.skills?.length) {
    sections.push(section('Skills', input.skills.map(skill => [
      `# ${skill.name}`,
      skill.description ? `Description: ${skill.description}` : '',
      skill.instructions,
    ].filter(Boolean).join('\n')).join('\n\n')))
  }

  if (input.memoryContext?.trim()) {
    sections.push(input.memoryContext.trim())
  }

  if (input.userSystemMessages?.length) {
    sections.push(section('User System Messages', input.userSystemMessages.filter(Boolean).join('\n\n')))
  }

  return sections.filter(Boolean).join('\n\n')
}

function section(title: string, content: string): string {
  return `## ${title}\n${content.trim()}`
}
