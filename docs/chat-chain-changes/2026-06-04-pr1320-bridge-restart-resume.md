---
date: 2026-06-04
pr: 1320
commit: 237fd954
feature: Agent Bridge restart/resume；shutdown/stop timing
impact: server 重启后 `ChatRunSocket.resume` 会查询 bridge status 并通过 `resumeBridgeRun()` 继续 poll 既有 `run_id` 的 delta/events。
---

Web UI `restart`/页面内升级通过 `SIGUSR2` 保留 Agent Bridge。真实 `stop`/`SIGTERM` 仍会请求 bridge shutdown；非桌面 shutdown 兜底延长到 15s 以覆盖 worker 清理窗口，桌面 `HERMES_DESKTOP=true` 默认仍保持 3s。CLI `restart` 仍使用 5s grace，CLI `stop` 最长等 15s 且进程退出后立即返回。
