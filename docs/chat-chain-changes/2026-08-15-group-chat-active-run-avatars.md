---
date: 2026-08-15
feature: issue-2552-group-chat-active-run-avatars
impact: Local Room rows now use the persisted Agent roster as a fixed grid identity, while exact run activity only decorates the matching Agent cells.
pr: 2573
---

# Issue #2552

Group Chat previously kept only the current Room's transient status keyed by Agent display name. That made historical cards for the same Agent indistinguishable from the live run and discarded activity in other Rooms. The server now publishes an authorized activity snapshot and realtime event keyed by `roomId + agentId + runId`; the client replaces that snapshot on reconnect and removes only matching terminal runs. The Room list also receives a minimal public projection of each Room's persisted, non-removed Agent roster. Local Room rows render that roster as a fixed 36px square grid: zero Agents use a neutral tile, one through four use stable centered/diagonal/triangle/2×2 layouts, and larger rosters use three avatars plus a final overflow cell. Runtime activity never creates or reorders grid cells; it only adds a restrained marker to the matching persisted Agent cell, with parallel runs deduplicated and reduced-motion users retaining a static outline. Agent add, edit, removal, Room switching, realtime roster broadcasts, and refreshes update the same authoritative projection. Remote Room rows and transcript activity behavior remain unchanged.
