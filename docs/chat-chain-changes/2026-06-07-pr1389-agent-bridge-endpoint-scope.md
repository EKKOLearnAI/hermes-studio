---
date: 2026-06-07
pr: 1389
feature: Agent Bridge endpoint isolation
impact: Web UI-managed bridge brokers now derive their default endpoint from the Web UI runtime home to avoid cross-instance broker attachment.
---

The explicit `HERMES_AGENT_BRIDGE_ENDPOINT` override remains supported. Windows Web UI-managed broker defaults use a runtime-home-derived port range below Version Preview and worker endpoint ranges.
