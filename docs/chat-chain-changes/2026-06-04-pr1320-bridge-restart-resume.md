---
date: 2026-06-04
pr: 1320
commit: 237fd954
feature: Agent Bridge restart/resume；shutdown/stop timing
impact: Historical restart-resume behavior: server 重启后 `ChatRunSocket.resume` 会查询 bridge status 并通过 `resumeBridgeRun()` 继续 poll 既有 `run_id` 的 delta/events。2026-06-25 起默认 restart 会关闭 bridge，需设置 `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0` 才保留此行为。
---

Historical behavior from PR 1320: Web UI `restart`/页面内升级通过 `SIGUSR2` 保留 Agent Bridge，而真实 `stop`/`SIGTERM` 会请求 bridge shutdown。2026-06-25 起默认策略已改为 restart/shutdown 都关闭 Agent Bridge broker；只有显式设置 `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0` 时才保留旧的 restart-resume 行为。CLI `restart` 仍使用较短 grace window，CLI `stop` 使用较长 grace window。
