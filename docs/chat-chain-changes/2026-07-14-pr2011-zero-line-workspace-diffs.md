---
date: 2026-07-14
pr: 2011
feature: Workspace diff zero-line filtering and historical cleanup
impact: Binary zero-line changes are omitted by a generic rule while text sidecar files with real line changes remain visible; stale zero-line history is repaired idempotently.
---

Workspace diff tracking no longer hides SQLite sidecar filenames unconditionally. Binary changes do not invent line counts, so generic `additions = 0 AND deletions = 0` filtering suppresses meaningless rows while text sidecars with real line changes remain visible. Schema initialization atomically removes historical zero-line child rows, deletes empty parent cards, and recomputes surviving parent aggregates.
