---
date: 2026-06-25
pr: pending
commit: pending
feature: Agent Bridge restart/shutdown policy
impact: Web UI shutdown and restart now stop the Agent Bridge broker by default so package upgrades do not reattach to stale bridge processes. Operators can keep the previous restart-resume behavior by setting HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0.
---

`shouldStopAgentBridgeOnShutdown()` now treats `SIGUSR2` restart signals the same as normal shutdown signals unless `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN` is explicitly set to a false value. This avoids reusing an old Python bridge broker after CLI or in-app updates replace the Web UI package files.
