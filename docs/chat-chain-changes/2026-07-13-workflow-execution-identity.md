---
date: 2026-07-13
pr: 11
feature: Workflow execution identity
impact: Workflow runs preserve the exact model target and reasoning effort through queueing and Agent Bridge execution.
---

Workflow Agent executions preserve the exact `provider` / `model` / `apiMode` / `reasoningEffort` tuple through Workflow snapshots, queued chat runs, Agent Bridge context estimation, and Agent construction. Workflow nodes otherwise use the selected Profile's normal Hermes tools, memory, and context-file behavior.
