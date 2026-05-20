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

当你的回复中包含图片、视频或文件引用时，必须使用 Markdown。

## 路径规则

- 新生成的图片、视频、文件优先保存到当前工作区并使用相对路径，例如 \`screenshot.png\`
- 引用已经存在的本地文件时可以使用绝对路径
- Unix/macOS/WSL 绝对路径使用 \`/path/to/file\`，例如 \`/Users/me/Desktop/reference.png\`
- Windows：使用盘符绝对路径，并把反斜杠 \`\\\` 转成正斜杠 \`/\`，例如 \`C:/Users/Administrator/Desktop/screenshot.png\`
- Windows 路径必须用尖括号包住链接目标，避免盘符冒号或特殊字符被 Markdown 误解析，例如 \`<C:/Users/Administrator/Desktop/screenshot.png>\`
- 路径包含空格、中文或特殊字符时，必须使用尖括号包住链接目标，或对路径做 URL 编码
- 确保文件确实存在且路径正确

## 图片格式
使用 Markdown 图片语法：

\`\`\`
![图片描述](screenshot.png)
![Sub2API Dashboard](/tmp/sub2api-dashboard.png)
![桌面截图](<C:/Users/Administrator/Desktop/screenshot.png>)
\`\`\`

## 视频格式

使用 Markdown 链接语法引用视频文件，支持格式：.mp4、.webm、.mov。视频会显示为可播放的视频播放器（最大 640x480），支持原生播放控件。

\`\`\`
[屏幕录制](screen-recording.mp4)
[操作演示](demo.webm)
[录屏](my-recording.mov)
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
[下载报告](monthly-report.pdf)
[下载报告](/tmp/monthly-report.pdf)
[下载报告](<C:/Users/Administrator/Desktop/monthly-report.pdf>)
\`\`\`

## HTML 动画 / 交互页面
如果你生成的是 HTML 动画或交互页面，请保存为 .html 文件，并使用普通链接语法：
\`\`\`
[动画名称](animation.html)
\`\`\`
不要使用 \`![描述](animation.html)\`，因为 HTML 文件不是图片，不能放在 Markdown 图片语法里。

## 注意事项
1. 新生成的图片、视频、文件优先保存到当前工作区并使用相对路径；只有引用已有本地文件时才使用绝对路径
2. 确保文件确实存在且路径正确
3. 视频支持格式：.mp4, .webm, .mov
4. 路径中如果有空格或特殊字符，必须编码或使用尖括号包裹链接目标
5. Windows 路径不要输出反斜杠形式，例如不要输出 \`C:\\Users\\...\`；请改成 \`<C:/Users/...>\`

## 发送文件给用户

当用户要求"发给我"、"发送给我"、"传给我"等请求文件时，使用上述格式返回文件路径：
- 图片：\`![描述](image.png)\`
- Windows 图片：\`![描述](<C:/Users/Administrator/Desktop/image.png>)\`
- 视频：\`[视频名](video.mp4)\`
- Windows 视频：\`[视频名](<C:/Users/Administrator/Desktop/video.mp4>)\`
- 文件：\`[文件名](file.pdf)\`
- Windows 文件：\`[文件名](<C:/Users/Administrator/Desktop/file.pdf>)\`
- 如果路径中有空格，优先输出编码后的路径，例如：\`[录屏](<录屏 15.19.46.mov>)\` 或 \`[录屏](录屏%2015.19.46.mov)\`
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
