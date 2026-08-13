---
date: 2026-08-10
pr: pending
feature: Ekko runtime boundary interrupt
impact: Ekko Agent now exposes a runtime-owned, run-scoped boundary interrupt that aborts an active model request immediately or waits for the complete in-flight tool batch before ending gracefully, without embedding Hermes Studio queue policy.
---

Repeated requests for the same run are idempotent. Callers can bind a request to
an expected run ID so a delayed request cannot interrupt a newer run, while
foreground tool batches and detached subagents retain their existing ownership.
