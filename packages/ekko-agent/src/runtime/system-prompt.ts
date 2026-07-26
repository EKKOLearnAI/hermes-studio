export interface SystemPromptInput {
  basePrompt?: string
  runtimeInstructions?: string[]
  userSystemMessages?: string[]
  memoryContext?: string
  skillDiscoveryEnabled?: boolean
  context?: {
    provider?: string
    model?: string
    cwd?: string
    workspaceRoot?: string
  }
}

const DEFAULT_BASE_PROMPT = '你是 Ekko Agent，一个务实的 AI 助手。你能够进行推理、使用工具，并给出简洁、准确的结果。'

export const EKKO_OUTPUT_FORMAT_GUIDELINES = `## 图片与文件输出
向用户返回图片、视频或文件时，使用 Markdown 引用一个真实存在的本地绝对路径。

- Unix/macOS/WSL 图片：\`![说明](/absolute/path/image.png)\`
- Windows 图片：\`![说明](<C:/absolute/path/image.png>)\`
- Unix/macOS/WSL 文件：\`[文件名](/absolute/path/file.pdf)\`
- Windows 文件：\`[文件名](<C:/absolute/path/file.pdf>)\`
- Windows 路径使用正斜杠。
- 路径包含空格、非 ASCII 字符或特殊字符时，用尖括号包裹路径。
- 不要使用相对路径或 \`file://\` URL。
- 返回前确认引用的文件确实存在。`

export function buildSystemPrompt(input: SystemPromptInput = {}): string {
  const sections: string[] = []
  sections.push(input.basePrompt?.trim() || DEFAULT_BASE_PROMPT)
  sections.push(EKKO_OUTPUT_FORMAT_GUIDELINES)

  if (input.runtimeInstructions?.length) {
    sections.push(section('运行时指令', input.runtimeInstructions.filter(Boolean).join('\n')))
  }

  if (input.context?.provider || input.context?.model || input.context?.workspaceRoot || input.context?.cwd) {
    const lines = [
      input.context.provider ? `provider: ${input.context.provider}` : '',
      input.context.model ? `model: ${input.context.model}` : '',
      input.context.workspaceRoot ? `workspaceRoot: ${input.context.workspaceRoot}` : '',
      input.context.cwd ? `cwd: ${input.context.cwd}` : '',
    ].filter(Boolean)
    sections.push(section('运行时上下文', lines.join('\n')))
  }

  if (input.skillDiscoveryEnabled) {
    sections.push(section(
      '技能发现',
      '当你不确定当前能力是否足以完成任务时，先调用 skill_list 查找相关技能。找到合适技能后，使用其准确名称调用 skill_view，并遵循加载到的指令。',
    ))
  }

  if (input.memoryContext?.trim()) {
    sections.push(input.memoryContext.trim())
  }

  if (input.userSystemMessages?.length) {
    sections.push(section('用户系统消息', input.userSystemMessages.filter(Boolean).join('\n\n')))
  }

  return sections.filter(Boolean).join('\n\n')
}

function section(title: string, content: string): string {
  return `## ${title}\n${content.trim()}`
}
