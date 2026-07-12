---
date: 2026-07-12
pr: pending
commit: pending
feature: workflow-execution-controls
impact: workflow run API, scheduler, approval gates, persistence, recovery, and partial rerun safety
---

- Validates workflow graphs, explicit start nodes, total deadlines, and execution budgets synchronously before accepting a run.
- Applies a fixed whole-run deadline across Agent execution and approval waits, aborting active sessions on timeout.
- Reserves execution budget before session creation and dispatch without oversubscribing parallel ready nodes.
- Persists effective deadline and budget values with each run snapshot for history and auditability.
- Fails interrupted queued or running runs and their unfinished node sessions closed during singleton runtime startup.
- Keeps user stop behavior wired to real session aborts and removes pending approval waiters on timeout or cancellation.
- Rejects partial rerun for orchestrated snapshots instead of silently executing them with legacy DAG semantics.
