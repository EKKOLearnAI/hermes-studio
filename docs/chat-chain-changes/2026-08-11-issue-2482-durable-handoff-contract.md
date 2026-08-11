---
date: 2026-08-11
pr: pending
feature: Issue #2482 durable handoff contract spike
impact: Defines the design-only Local/Remote durable handoff protocol and its real crash-injection RED matrix; no production integration is included.
---

Issue #2482 Stage A freezes independent Source outbox and Target SQLite inbox
boundaries, authenticated `admit/getStatus`, monotonic state versions, stable
execution identity, terminal-publication evidence, manual replacement lineage,
and deletion tombstones. Socket callbacks, Promise resolution, memory queues,
and synthetic message IDs are explicitly not completion evidence.

The spike remains design-only until an independent `DESIGN_PASS`. Its RED
matrix covers lost admission responses, lost completion callbacks, concurrent
dispatch, pre-invocation and post-invocation crashes, Local/Remote parity,
payload/snapshot conflicts, offline/busy retry, replacement, tombstones, and
the full source-to-terminal-publication path.
