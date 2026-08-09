---
date: 2026-08-09
pr: 2445
feature: Authoritative Group Chat token cache ownership
impact: Agent context-status side-channel events remain available for live status UI but no longer overwrite the persisted bounded Room context-window token total.
---

Room token totals are now written only by the persisted message-accounting path. Agent-local context status can represent a different session or accounting window, so accepting its `totalTokens` value would corrupt the versioned incremental cache and make later message deltas start from the wrong base.
