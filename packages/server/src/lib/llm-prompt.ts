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
使用 Markdown 图片语法，路径必须是本地绝对路径：
- Unix/macOS/WSL 路径以 \`/\` 开头，例如 \`/tmp/screenshot.png\`
- Windows 路径使用盘符绝对路径，并把反斜杠 \`\\\` 转成正斜杠 \`/\`，例如 \`C:/Users/Administrator/Desktop/screenshot.png\`
- Windows 路径必须用尖括号包住链接目标，避免盘符冒号和路径字符被 Markdown 误解析
\`\`\`
![图片描述](/tmp/screenshot.png)
![图片描述](<C:/Users/Administrator/Desktop/screenshot.png>)
\`\`\`
示例：
\`\`\`
![Sub2API Dashboard](/tmp/sub2api-dashboard.png)
![桌面截图](<C:/Users/Administrator/Desktop/screenshot.png>)
\`\`\`

## 视频格式
使用 Markdown 链接语法引用视频文件，路径必须是本地绝对路径，支持的格式：mp4, webm, mov
\`\`\`
[视频名称](/tmp/recording.mp4)
[视频名称](<C:/Users/Administrator/Desktop/recording.mp4>)
\`\`\`
示例：
\`\`\`
[屏幕录制](/tmp/screen-recording.mp4)
[操作演示](/tmp/demo.webm)
[录屏2026-05-08 15.19.46](/Users/ekko/Desktop/录屏2026-05-08%2015.19.46.mov)
[Windows 录屏](<C:/Users/Administrator/Desktop/screen recording.mov>)
\`\`\`
视频会显示为可播放的视频播放器（最大 640x480），支持原生播放控件。

如果路径包含空格、中文或其他特殊字符，必须使用以下两种写法之一：
1. 对路径做 URL 编码，至少把空格写成 \`%20\`
2. 用尖括号包住链接目标

示例：
\`\`\`
[录屏2026-05-08 15.19.46](/Users/ekko/Desktop/录屏2026-05-08%2015.19.46.mov)
[录屏2026-05-08 15.19.46](</Users/ekko/Desktop/录屏2026-05-08 15.19.46.mov>)
\`\`\`

错误示例：
\`\`\`
[录屏2026-05-08 15.19.46](/Users/ekko/Desktop/录屏2026-05-08 15.19.46.mov)
![桌面截图](C:\\Users\\Administrator\\Desktop\\screenshot.png)
\`\`\`

## 文件链接格式
使用 Markdown 链接语法，路径必须是本地绝对路径：
\`\`\`
[文件名](/tmp/report.pdf)
[文件名](<C:/Users/Administrator/Desktop/report.pdf>)
\`\`\`
示例：
\`\`\`
[下载报告](/tmp/monthly-report.pdf)
[下载报告](<C:/Users/Administrator/Desktop/monthly-report.pdf>)
\`\`\`

## 注意事项
1. 图片、视频、文件路径必须使用本地绝对路径：Unix/macOS/WSL 使用 \`/path/to/file\`，Windows 使用 \`C:/path/to/file\`
2. 确保文件确实存在且路径正确
3. 视频支持格式：.mp4, .webm, .mov
4. 路径中如果有空格或特殊字符，必须编码或使用尖括号包裹链接目标
5. Windows 路径不要输出反斜杠形式，例如不要输出 \`C:\\Users\\...\`；请改成 \`<C:/Users/...>\`

## 发送文件给用户
当用户要求"发给我"、"发送给我"、"传给我"等请求文件时，使用上述格式返回文件路径：
- 图片：\`![描述](/path/to/image.png)\`
- Windows 图片：\`![描述](<C:/Users/Administrator/Desktop/image.png>)\`
- 视频：\`[视频名](/path/to/video.mp4)\`
- Windows 视频：\`[视频名](<C:/Users/Administrator/Desktop/video.mp4>)\`
- 文件：\`[文件名](/path/to/file.pdf)\`
- Windows 文件：\`[文件名](<C:/Users/Administrator/Desktop/file.pdf>)\`
- 如果路径中有空格，优先输出编码后的路径，例如：\`[录屏](</tmp/录屏 15.19.46.mov>)\` 或 \`[录屏](/tmp/录屏%2015.19.46.mov)\`
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
