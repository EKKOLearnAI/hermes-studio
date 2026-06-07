---
date: 2026-06-07
pr: 1389
feature: Agent Bridge endpoint isolation
impact: Web UI-managed bridge brokers now derive their default endpoint from the Web UI runtime home to avoid cross-instance broker attachment.
---

The explicit `HERMES_AGENT_BRIDGE_ENDPOINT` override remains supported. Windows Web UI-managed broker defaults use a runtime-home-derived port range below Version Preview and worker endpoint ranges.

中文摘要：Web UI 管理的 Agent Bridge 默认地址现在从运行目录派生，不再复用全局 socket 或固定 Windows 端口；显式 `HERMES_AGENT_BRIDGE_ENDPOINT` 覆盖仍然生效。
