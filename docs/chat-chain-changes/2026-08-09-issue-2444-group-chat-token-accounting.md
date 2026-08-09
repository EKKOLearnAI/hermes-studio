---
date: 2026-08-09
pr: 2445
feature: Bounded Group Chat token accounting
impact: Group Chat message persistence updates the cached context-window token total incrementally and uses bounded estimation for oversized text so HTTP health checks remain responsive under large tool results.
---

The canonical context window remains 500 messages and preserves ordinary same-timestamp multipart boundaries with a bounded overflow allowance. Pathological same-timestamp floods are capped so a malformed or adversarial room cannot make one persistence turn unbounded. Exact persisted room total semantics remain unchanged for normal-sized messages. Workspace diff messages continue to be excluded from the shared context total.
