---
date: 2026-06-04
commit: local
feature: CLI bridge abort 超时同步
impact: abort 超时时不再提前释放 session，避免旧 Agent run 尚未退出时触发 `session ... is already running`。
---

`/chat-run` abort 路径在 Hermes Agent 协作式 interrupt 未能在 bridge 同步窗口内完成时，不再提前清理 Web UI `isWorking/runId` 或启动队列，而是发送 `abort.timeout` 并保持 session locked/aborting；同会话新消息继续进入队列。当前端后续收到 bridge terminal chunk 时再发送 `abort.completed` 并释放状态。前端新增 `abort.timeout` 事件展示“仍在停止中”，并移除本地 20s 自动清 running 兜底。
