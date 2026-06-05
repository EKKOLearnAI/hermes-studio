---
date: 2026-06-04
pr: 1302
feature: 会话协议链接 profile-aware 打开
impact: `session://<id>` 打开、Markdown 重写、搜索精确打开和 `/chat-run` resume 保留并校验 session profile。
---

`session://<id>` 解析、Markdown 重写、搜索精确打开、侧栏/上下文菜单链接和 `/chat-run` resume 现在保留并校验 session profile。普通 Chat 的新建、发送和 CLI bridge run 入口不变；切换/恢复会话时使用 `{id, profile}` 避免跨 profile 误开。
