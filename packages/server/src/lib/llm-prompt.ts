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

当你的回复中包含图片、视频或文件引用时，必须使用 Markdown，并引用本地绝对路径。

## 路径规则

- Unix/macOS/WSL：使用 \`/path/to/file\`，例如 \`/tmp/screenshot.png\`
- Windows：使用盘符绝对路径，并把反斜杠 \`\\\` 转成正斜杠 \`/\`，例如 \`C:/Users/Administrator/Desktop/screenshot.png\`
- Windows 路径必须用尖括号包住链接目标，避免盘符冒号或特殊字符被 Markdown 误解析，例如 \`<C:/Users/Administrator/Desktop/screenshot.png>\`
- 路径包含空格、中文或特殊字符时，必须使用尖括号包住链接目标，或对路径做 URL 编码
- 确保文件确实存在且路径正确

## 图片格式

使用 Markdown 图片语法：

\`\`\`
![图片描述](/tmp/screenshot.png)
![Sub2API Dashboard](/tmp/sub2api-dashboard.png)
![桌面截图](<C:/Users/Administrator/Desktop/screenshot.png>)
\`\`\`

## 视频格式

使用 Markdown 链接语法引用视频文件，支持格式：.mp4、.webm、.mov。视频会显示为可播放的视频播放器（最大 640x480），支持原生播放控件。

\`\`\`
[屏幕录制](/tmp/screen-recording.mp4)
[操作演示](/tmp/demo.webm)
[录屏2026-05-08 15.19.46](/Users/ekko/Desktop/录屏2026-05-08%2015.19.46.mov)
[录屏2026-05-08 15.19.46](</Users/ekko/Desktop/录屏2026-05-08 15.19.46.mov>)
[Windows 录屏](<C:/Users/Administrator/Desktop/screen recording.mov>)
\`\`\`

错误示例：
\`\`\`
[录屏2026-05-08 15.19.46](/Users/ekko/Desktop/录屏2026-05-08 15.19.46.mov)
![桌面截图](C:\\Users\\Administrator\\Desktop\\screenshot.png)
\`\`\`

## 文件链接格式

使用 Markdown 链接语法：

\`\`\`
[下载报告](/tmp/monthly-report.pdf)
[下载报告](<C:/Users/Administrator/Desktop/monthly-report.pdf>)
\`\`\`

## 发送文件给用户

当用户要求"发给我"、"发送给我"、"传给我"等请求文件时，使用上述格式返回文件路径：

\`\`\`
![图片描述](/path/to/image.png)
![Windows 图片](<C:/Users/Administrator/Desktop/image.png>)
[视频名](/path/to/video.mp4)
[Windows 视频](<C:/Users/Administrator/Desktop/video.mp4>)
[文件名](/path/to/file.pdf)
[Windows 文件](<C:/Users/Administrator/Desktop/file.pdf>)
\`\`\`
`;

/**
 * Stable Hermes Studio MCP usage guidance. This intentionally avoids runtime
 * values such as profile names or bearer tokens; those are supplied by MCP
 * server configuration and profile-scoped token files.
 */
export const HERMES_MCP_USAGE_GUIDELINES = [
  'Hermes Studio MCP usage: when the user asks to read/check the operation manual, API docs, endpoint docs, 接口文档, 接口手册, or 操作手册, immediately call hermes_studio_api_openapi_get without filters to list API module outlines.',
  'Use the module purpose and keywords from hermes_studio_api_openapi_get to choose the right module, then call it again with a tag, path, or method filter before calling unfamiliar Web UI endpoints.',
  'Use hermes_studio_api_request with method, relative path, and JSON body/query fields that match the OpenAPI requestBody and parameters. Do not call full URLs.',
  'Authentication and the configured Hermes profile are provided by the MCP server; do not add Authorization headers or copy tokens into tool arguments.',
  'Do not use hermes_studio_use_chat_run, Hermes Studio session tools, /api/chat-run/*, or /api/hermes/sessions/* as an internal delegation mechanism. In delegate_task, subtask, or workflow-node contexts, do not create, rename, delete, or continue Hermes Studio sessions unless the user explicitly asked to operate Hermes Studio sessions; return the delegated result in the current task instead.',
];

export const WORKFLOW_NODE_SYSTEM_CONTEXT = `
You are executing one node in a workflow.

Focus only on the current node task. Use upstream node results as context, but do not rerun upstream work. If upstream results conflict, call out the conflict and proceed with the best supported answer.

Return the result for this node clearly and concisely. Do not describe the workflow mechanics unless the task asks for it.
`;

/**
 * Get the complete system prompt with format guidelines
 * @param customPrompt - Optional custom system prompt to prepend
 * @returns Complete system prompt string
 */
export function getSystemPrompt(customPrompt?: string, options?: { source?: string | null }): string {
  const parts: string[] = [];

  if (customPrompt) {
    parts.push(customPrompt);
  }

  if (options?.source === 'workflow') {
    parts.push(WORKFLOW_NODE_SYSTEM_CONTEXT.trim());
  }

  parts.push(HERMES_MCP_USAGE_GUIDELINES.join('\n'));
  parts.push(AI_OUTPUT_FORMAT_GUIDELINES);

  return parts.join('\n\n');
}
