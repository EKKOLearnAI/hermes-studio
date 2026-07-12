---
date: 2026-07-05
pr: 1944
commit: 4cb55e6
feature: coding agent API mode persistence
impact: Scoped Codex / Claude Code sessions now persist the selected API mode and reuse it across session refreshes, model reselects, and service restarts instead of falling back to provider defaults.
---

代码代理会话现在会把 `api_mode` 和 `model/provider` 一起写入本地 session store，并在会话列表、resume、分叉和模型切换链路中保留该字段。

继续会话或服务重启后，coding-agent launch 会优先读取已保存的 API 模式；运行兼容性也会比较 `apiMode`，当 API 模式变化时会重启 scoped run 并清空原生会话 id，避免复用旧协议线程。
