---
date: 2026-08-15
feature: issue-2552-group-chat-active-run-avatars
impact: Active Agent runs now retain stable room, Agent-record, and run identity across Room switches and reconnects, with exact transcript animation and authorized cross-Room avatar summaries.
pr: pending
---

# Issue #2552

Group Chat previously kept only the current Room's transient status keyed by Agent display name. That made historical cards for the same Agent indistinguishable from the live run and discarded activity in other Rooms. The server now publishes an authorized activity snapshot and realtime event keyed by `roomId + agentId + runId`; the client replaces that snapshot on reconnect, removes only matching terminal runs, animates only the matching transcript avatar, and shows up to three active avatars plus an overflow count in each local Room row. Disconnects, interruptions, Room deletion, context clearing, and Agent removal clear the corresponding transient state. Reduced-motion users keep a static active outline instead of animation.
