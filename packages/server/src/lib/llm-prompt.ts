/**
 * LLM System Prompts and Instructions
 *
 * This module contains system prompts and format guidelines for LLM agents.
 * These prompts ensure that AI outputs are correctly rendered by the frontend.
 */

/**
 * System prompt for AI output format guidelines
 * Add this to your agent's system prompt to ensure proper formatting
 */
export const AI_OUTPUT_FORMAT_GUIDELINES = `
# 输出格式规范

当你的回复中包含图片、视频或文件引用时，请遵循以下格式规范：

## 图片格式
使用 Markdown 图片语法，路径必须是本地绝对路径（以 / 开头）：
\`\`\`
![图片描述](/tmp/screenshot.png)
\`\`\`
示例：
\`\`\`
![Sub2API Dashboard](/tmp/sub2api-dashboard.png)
\`\`\`

## 视频格式
使用 Markdown 链接语法，路径必须是本地绝对路径（以 / 开头），支持的格式：mp4, webm
\`\`\`
[视频名称](/tmp/recording.mp4)
\`\`\`
示例：
\`\`\`
[屏幕录制](/tmp/screen-recording.mp4)
[操作演示](/tmp/demo.webm)
\`\`\`

## 文件链接格式
使用 Markdown 链接语法，路径必须是本地绝对路径（以 / 开头）：
\`\`\`
[文件名](/tmp/report.pdf)
\`\`\`
示例：
\`\`\`
[下载报告](/tmp/monthly-report.pdf)
\`\`\`

## 注意事项
1. 图片和文件路径必须以 / 开头的绝对路径
2. 图片会自动显示在对话中，缩略图尺寸 200x160px
3. 视频和文件链接点击后会自动下载
4. 视频文件大小建议不超过 200MB
5. 不要使用相对路径（如 ./file.png）
6. 不要使用 http:// 或 https:// 开头的远程链接表示本地文件
7. 视频支持格式：.mp4, .webm
`;

/**
 * Get the complete system prompt with format guidelines
 * @param customPrompt - Optional custom system prompt to prepend
 * @returns Complete system prompt string
 */
export function getSystemPrompt(customPrompt?: string): string {
  const parts: string[] = [];

  if (customPrompt) {
    parts.push(customPrompt);
  }

  parts.push(AI_OUTPUT_FORMAT_GUIDELINES);

  return parts.join('\n\n');
}

