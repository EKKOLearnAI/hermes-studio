export interface SystemPromptInput {
  basePrompt?: string
  runtimeInstructions?: string[]
  userSystemMessages?: string[]
  memoryContext?: string
  clarificationEnabled?: boolean
  skillDiscoveryEnabled?: boolean
  skillManagementEnabled?: boolean
  skillNames?: string[]
  context?: {
    provider?: string
    model?: string
    profile?: string
    cwd?: string
    workspaceRoot?: string
    platform?: NodeJS.Platform
    arch?: string
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
- Request independent tool calls together in one response. The runtime executes tools marked as parallel-safe concurrently while preserving serial barriers for stateful or dependent work.
- When the user asks to execute or evaluate Node.js, JavaScript, or Python source code, use code_exec, including for one-line snippets. Do not probe Node or Python with terminal_exec first; code_exec resolves its runtime.
- Use terminal_exec for CLI commands, project scripts, tests, builds, package managers, and other executables.
- terminal_exec may use explicit absolute system paths and platform-appropriate package-manager forms. Follow the Command Environment section below; this capability is not limited to workspace files.
- By default, keep downloads, clones, archives, extracted repositories, and generated intermediates inside the current workspace. Prefer the workspace's .ekko-tmp directory for disposable files so workspace-scoped file and image tools can inspect them. Use a system or external path only when the user or task explicitly requires it.
- Dangerous tool calls may pause for runtime authorization. If authorization is denied, do not retry the operation through another tool or language runtime unless the user explicitly changes that decision.
- After terminal_exec reports a [skill_validation] issue, do not claim the Skill installation is complete. Call skill_view for each writable local Skill and repair it with skill_manage until its frontmatter passes validation. Do not mutate read-only external Skill directories.
- If a dependency is unavailable, prefer a compatible installed or built-in alternative. Install it only when installation is necessary and appropriate for the user's task.
- Verify created artifacts before returning them.`

export const EKKO_CLARIFICATION_GUIDELINES = `## User Clarification
When missing user input materially blocks or changes the task, call the clarify tool and wait for the response.

- Do not present a blocking clarification question as an ordinary assistant response.
- Ask one concise question that collects the necessary information; provide choices only for a short fixed set of answers.
- Do not call clarify when a safe, reasonable assumption lets you continue without materially changing the outcome.`

export function buildSystemPrompt(input: SystemPromptInput = {}): string {
  const sections: string[] = []
  sections.push(input.basePrompt?.trim() || DEFAULT_BASE_PROMPT)
  sections.push(EKKO_OUTPUT_FORMAT_GUIDELINES)
  sections.push(EKKO_TOOL_EXECUTION_GUIDELINES)
  sections.push(commandEnvironmentGuidelines(
    input.context?.platform ?? process.platform,
    input.context?.arch ?? process.arch,
  ))
  if (input.clarificationEnabled) sections.push(EKKO_CLARIFICATION_GUIDELINES)

  if (input.runtimeInstructions?.length) {
    sections.push(section('Runtime Instructions', input.runtimeInstructions.filter(Boolean).join('\n')))
  }

  if (input.context?.provider || input.context?.model || input.context?.profile || input.context?.workspaceRoot || input.context?.cwd) {
    const lines = [
      input.context.provider ? `provider: ${input.context.provider}` : '',
      input.context.model ? `model: ${input.context.model}` : '',
      input.context.profile ? `profile: ${input.context.profile}` : '',
      input.context.workspaceRoot ? `workspaceRoot: ${input.context.workspaceRoot}` : '',
      input.context.cwd ? `cwd: ${input.context.cwd}` : '',
    ].filter(Boolean)
    sections.push(section('Runtime Context', lines.join('\n')))
  }

  if (input.skillDiscoveryEnabled) {
    const skillNames = normalizeSkillNames(input.skillNames)
    if (skillNames.length) {
      sections.push(section('Available Skill Names', skillNames.join(', ')))
    }
    sections.push(section(
      'Skill Discovery',
      [
        'Interpret the user request in its own language and compare its intent with the available Skill names above. When one clearly applies, call skill_view directly with that exact name before proceeding, then follow the loaded instructions.',
        'The runtime may preload an exact host-side name or keyword match through skill_view. Use skill_list only as a fallback when the injected names are ambiguous or insufficient.',
        'When the current conversation already contains a complete, non-truncated skill_view result for the same Skill, reuse those instructions instead of calling skill_view again.',
      ].join('\n'),
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

function commandEnvironmentGuidelines(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'win32') {
    return `## Command Environment
Host platform: Windows (${arch}). Generate Windows-native commands.

- terminal_exec launches the provided executable directly and does not add an implicit shell.
- Do not use Unix-only commands or paths such as sh, bash, ls, cat, grep, sed, awk, head, tail, which, /bin/sh, or /tmp unless this run has already established that a Unix compatibility layer provides them.
- Prefer the workspace file tools for file access instead of shell-specific cat or type commands.
- Run ordinary executables directly with separate command and args values.
- For cmd built-ins, pipelines, redirection, or compound command lines, explicitly use command=cmd.exe with args=["/d", "/s", "/c", "..."] only when necessary.
- Windows .cmd and .bat launchers, including many package-manager shims, are command scripts; invoke them through cmd.exe rather than treating them as native executables.
- For PowerShell syntax, explicitly use powershell.exe or pwsh.exe with -NoProfile and -Command. Do not send PowerShell syntax to cmd.exe.
- Use where.exe to locate an executable, or Get-Command inside PowerShell. Do not use which.
- Use Windows paths and quote path arguments with spaces. Do not invent drive letters or assume WSL is installed.`
  }

  if (platform === 'darwin') {
    return `## Command Environment
Host platform: macOS (${arch}). Generate macOS-native commands.

- terminal_exec launches the provided executable directly and does not add an implicit shell.
- Run ordinary executables directly with separate command and args values. Invoke sh or zsh explicitly only when pipelines, redirection, globbing, or compound shell syntax is necessary.
- Do not use Windows-only commands, PowerShell syntax, drive-letter paths, or cmd.exe.
- macOS command-line utilities are BSD variants; do not assume GNU-only flags are available.
- Prefer the workspace file tools for file access instead of cat-based shell pipelines.`
  }

  return `## Command Environment
Host platform: ${platform === 'linux' ? 'Linux' : platform} (${arch}). Generate commands native to this platform.

- terminal_exec launches the provided executable directly and does not add an implicit shell.
- Run ordinary executables directly with separate command and args values. Invoke sh or bash explicitly only when pipelines, redirection, globbing, or compound shell syntax is necessary.
- Do not use Windows-only commands, PowerShell syntax, drive-letter paths, or cmd.exe unless this run has already established that they are available.
- Prefer the workspace file tools for file access instead of cat-based shell pipelines.`
}

function section(title: string, content: string): string {
  return `## ${title}\n${content.trim()}`
}

function normalizeSkillNames(names: string[] | undefined): string[] {
  return [...new Set((names || [])
    .map(name => String(name || '').trim())
    .filter(name => /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i.test(name)))]
    .sort((left, right) => left.localeCompare(right))
}
