---
date: 2026-08-10
pr: pending
feature: Hermes Bridge boundary interrupt
impact: Agent Bridge now exposes a strict run-scoped boundary interrupt that stops an active Hermes model request immediately or waits for the complete in-flight tool batch without cancelling detached subagents.
---

The Bridge capability-checks Hermes' private whole-batch method before wrapping
it and fails closed with `unsupported` when the installed runtime is
incompatible. Duplicate requests are idempotent, expected run IDs fence stale
requests, and the broad user-stop path continues to supersede pending boundary
requests.
