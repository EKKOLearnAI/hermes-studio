---
date: 2026-06-07
pr: 1393
feature: Agent Bridge runtime readiness
impact: Chat resume and new CLI runs now distinguish bridge readiness from base server health, surface sanitized bridge failures, and avoid destructive recovery on chat-path checks.
---

`/health` keeps its top-level compatibility status while adding nested `agent_bridge` readiness. New CLI chat runs perform a non-destructive readiness gate before dispatch. Resume uncertainty emits a non-terminal `run.reattach_failed` warning that is replayed in the `resumed` payload so the UI can show the user why bridge status could not be confirmed without marking the run failed.

Queued CLI runs that fail the readiness gate before dispatch now report the remaining queue length and continue dequeuing the next queued item, matching the existing bridge terminal failure path.
