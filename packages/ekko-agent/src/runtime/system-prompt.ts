export interface SystemPromptInput {
  basePrompt?: string
  runtimeInstructions?: string[]
  userSystemMessages?: string[]
  memoryContext?: string
  skillDiscoveryEnabled?: boolean
  skillManagementEnabled?: boolean
  context?: {
    provider?: string
    model?: string
    cwd?: string
    workspaceRoot?: string
  }
}

const DEFAULT_BASE_PROMPT = 'You are Ekko Agent, a pragmatic AI agent that can reason, use tools, and return concise results.'

export const EKKO_OUTPUT_FORMAT_GUIDELINES = `## Image and File Output
When returning an image, video, or file to the user, use Markdown with an existing local absolute path.

- Unix/macOS/WSL image: \`![description](/absolute/path/image.png)\`
- Windows image: \`![description](<C:/absolute/path/image.png>)\`
- Unix/macOS/WSL file: \`[filename](/absolute/path/file.pdf)\`
- Windows file: \`[filename](<C:/absolute/path/file.pdf>)\`
- Use forward slashes for Windows paths.
- Wrap paths containing spaces, non-ASCII characters, or special characters in angle brackets.
- Do not use relative paths or \`file://\` URLs.
- Verify that the referenced file exists before returning it.`

export const EKKO_TOOL_EXECUTION_GUIDELINES = `## Tool Execution
Treat external commands, language packages, and other prerequisites named by a Skill as requirements, not proof that they are installed.

- Before relying on an external dependency whose availability has not already been established, perform a lightweight availability check.
- Do not run the primary dependency-based approach merely to discover whether its dependency exists.
- If a dependency is unavailable, prefer a compatible installed or built-in alternative. Install it only when installation is necessary and appropriate for the user's task.
- Verify created artifacts before returning them.`

export function buildSystemPrompt(input: SystemPromptInput = {}): string {
  const sections: string[] = []
  sections.push(input.basePrompt?.trim() || DEFAULT_BASE_PROMPT)
  sections.push(EKKO_OUTPUT_FORMAT_GUIDELINES)
  sections.push(EKKO_TOOL_EXECUTION_GUIDELINES)

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

  if (input.skillDiscoveryEnabled) {
    sections.push(section(
      'Skill Discovery',
      'When you are not sure whether your current capabilities are sufficient for a task, call skill_list before proceeding to look for a relevant skill. If a suitable skill is available, call skill_view with its exact name, then follow those instructions.',
    ))
  }

  if (input.skillManagementEnabled) {
    sections.push(section(
      'Skill Evolution',
      [
        'Skills are reusable procedural memory. After a complex tool-heavy task, a tricky correction, or a non-trivial workflow, consider preserving the durable approach with skill_manage.',
        'Before changing an existing skill file, read that exact file with skill_view in the same run. Prefer a small patch over a full edit.',
        'Create only class-level reusable skills, never one-off task logs, transient failures, secrets, or issue-specific narratives. Use delete only for an explicit removal task; confirmed=true is an internal safeguard, not a human approval flow.',
      ].join('\n'),
    ))
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
