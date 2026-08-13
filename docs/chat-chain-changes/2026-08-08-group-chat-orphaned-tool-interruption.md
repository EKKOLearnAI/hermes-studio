---
date: 2026-08-08
pr: 2429
feature: Group Chat orphaned tool-call terminal state
impact: Historical Tool calls without a persisted Tool result remain running only for the active Agent's latest Run; calls with no active Run now render as interrupted with an explicit unavailable-result label, without fabricating Tool results or rewriting stored history.
---

Group Chat message mapping now distinguishes a genuinely active Agent Run from a
historical Tool call whose result was never persisted. Only the latest pending
Tool call belonging to an active Agent remains in the running state. Other
orphaned calls settle to the neutral interrupted state instead of displaying a
permanent spinner.

The message renderer displays a localized notice that execution was interrupted
and no Tool result was received. This is a presentation-time convergence only:
it does not synthesize a Tool result, backfill messages, or modify historical
Room data.
