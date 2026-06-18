---
date: 2026-06-18
pr: 1646
commit: c98e1eb
feature: 错误处理保护已有回复
impact: 修复 run.failed 事件覆盖正在流式的助手消息的问题。当助手已输出超过 100 字符内容时，错误消息不再覆盖原回复，而是作为独立消息追加。
---

`addAgentErrorMessage` 在 `isStreaming` 为 true 时不再无条件覆盖助手消息内容，而是检查内容长度：超过 100 字符仅关闭流式状态并追加独立错误消息，保持原有回复可见。
