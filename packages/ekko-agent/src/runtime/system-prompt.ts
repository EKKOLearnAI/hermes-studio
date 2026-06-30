import type { AgentToolDefinition } from '../model/types'
import type { AgentSkill } from '../skills/types'

export interface SystemPromptInput {
  basePrompt?: string
  runtimeInstructions?: string[]
  userSystemMessages?: string[]
  skills?: AgentSkill[]
  tools?: AgentToolDefinition[]
  context?: {
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

  if (input.context?.workspaceRoot || input.context?.cwd) {
    const lines = [
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

  if (input.tools?.length) {
    sections.push(section('Available Tools', input.tools.map(tool => {
      const description = tool.description ? `: ${tool.description}` : ''
      return `- ${tool.name}${description}`
    }).join('\n')))
  }

  if (input.userSystemMessages?.length) {
    sections.push(section('User System Messages', input.userSystemMessages.filter(Boolean).join('\n\n')))
  }

  return sections.filter(Boolean).join('\n\n')
}

function section(title: string, content: string): string {
  return `## ${title}\n${content.trim()}`
}
