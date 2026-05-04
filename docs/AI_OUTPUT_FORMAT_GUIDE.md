# AI 输出格式规范

为了让前端正确渲染大模型返回的图片、文件等内容，需要在系统提示词中定义以下格式约束。

## 系统提示词模板

将以下内容添加到你的系统提示词或 Agent 配置中：

```
当你的回复中包含图片或文件引用时，请遵循以下格式规范：

## 图片格式
使用 Markdown 图片语法，路径必须是本地绝对路径（以 / 开头）：
`
![图片描述](/tmp/screenshot.png)
`
示例：
`
![Sub2API Dashboard](/tmp/sub2api-dashboard.png)
`

## 文件链接格式
使用 Markdown 链接语法，路径必须是本地绝对路径（以 / 开头）：
[文件名](/tmp/report.pdf)
示例：
[下载报告](/tmp/monthly-report.pdf)

## 注意事项
1. 图片和文件路径必须以 / 开头的绝对路径
2. 图片会自动显示在对话中
3. 文件链接点击后会自动下载
4. 不要使用相对路径（如 ./file.png）
5. 不要使用 http:// 或 https:// 开头的远程链接表示本地文件
```

## 完整示例

### 推荐：添加到 Hermes 配置文件

在你的 Hermes 配置文件（`~/.hermes/config.yaml` 或项目配置）中添加：

```yaml
agents:
  your_agent_name:
    system_prompt: |
      你是一个智能助手。

      当你的回复中包含图片或文件引用时，请遵循以下格式规范：

      ## 图片格式
      使用 Markdown 图片语法：
      ![图片描述](/tmp/screenshot.png)

      ## 文件链接格式
      使用 Markdown 链接语法：
      [文件名](/tmp/report.pdf)

      ## 注意事项
      - 图片和文件路径必须以 / 开头的绝对路径
      - 图片会自动显示在对话中
      - 文件链接点击后会自动下载
```

### 或者：在 Web UI 中配置

1. 打开 Hermes Web UI
2. 进入 **Settings** → **Model Settings**
3. 在 **System Instructions** 或 **Agent Instructions** 中添加上述提示词内容

## 支持的内容格式

| 类型 | Markdown 语法 | 前端渲染效果 |
|------|--------------|------------|
| 🖼️ 图片 | `
![描述](/tmp/file.png)
` | 自动显示图片，通过 download 接口加载 |
| 📄 文件下载 | `[文件名](/tmp/file.pdf)` | 可点击链接，点击后下载文件 |
| 🔗 外部链接 | `[文本](https://example.com)` | 在新标签页打开 |
| 💻 代码块 | ` ```language\ncode\n``` ` | 语法高亮显示，支持一键复制 |

## 调试技巧

如果图片或文件没有正确显示，检查：

1. **路径格式**：确保路径以 `/` 开头（如 `/tmp/file.png`）
2. **Markdown 语法**：确保使用正确的 Markdown 语法
3. **文件存在**：确保文件确实存在于服务器上
4. **下载接口**：检查 `/api/hermes/download` 接口是否正常工作

## 示例对话

### 正确格式 ✅

**用户**：帮我截个屏
**AI**：
```
截图成功！这是当前页面的截图：

![Screenshot](//tmp/screenshot-20250104-143020.png)
```

### 错误格式 ❌

**AI**：
```
截图保存在 /tmp/screenshot.png
```
→ 这不会显示图片，因为没有使用 Markdown 图片语法

## 高级用法

### ContentBlock 格式

如果需要更复杂的消息结构，可以使用 JSON ContentBlock 格式：

```json
[
  {
    "type": "text",
    "text": "这是分析结果："
  },
  {
    "type": "image",
    "name": "screenshot.png",
    "path": "/tmp/screenshot.png",
    "media_type": "image/png"
  },
  {
    "type": "file",
    "name": "report.pdf",
    "path": "/tmp/report.pdf",
    "media_type": "application/pdf"
  }
]
```

前端会自动解析并渲染这种格式。

## 相关文件

- 前端渲染逻辑：`packages/client/src/components/hermes/chat/MarkdownRenderer.vue`
- 下载接口：`packages/server/src/controllers/hermes/sessions.ts`
- API 层：`packages/client/src/api/hermes/download.ts`
