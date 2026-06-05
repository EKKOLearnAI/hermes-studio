---
date: 2026-06-03
pr: 1289
commit: 7848256
feature: tool result / unified diff 展示
impact: 不改变 `/chat-run` 协议、消息落库、工具审批或 group-chat agent 执行行为。
---

`MessageItem.vue`、`GroupMessageItem.vue`、`MarkdownRenderer.vue` 和共享 highlighter 对 unified diff 走专门展示路径：tool result JSON 中的 diff 字段只显示 diff body，长段未改动上下文静态折叠，复制仍保留完整原始内容。
