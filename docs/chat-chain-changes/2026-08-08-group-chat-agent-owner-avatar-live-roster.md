---
date: 2026-08-08
commit: pending
feature: Stable Group Chat Agent owner avatars during live roster updates
impact: Removing or updating a Room Agent no longer temporarily hides the owner-avatar badges of the remaining Agents.
---

## Stable Agent owner avatars during live roster updates

- Merges realtime and mutation-response Agent rosters with the current Room roster instead of discarding previously issued ownership metadata when a public response omits it.
- Returns the same display-safe Agent view from mutation broadcasts and responses, including derived owner metadata for server-hosted Agents.
- Preserves `ownerMemberId` for every unchanged Agent so its owner-avatar badge remains visible without a page refresh.
- Continues to preserve private connector fields only for the current member's own remote Agent.
- Applies the same merge behavior to realtime joins and Agent list, add, update, remove, and member-removal refreshes.
