---
date: 2026-08-15
feature: issue-2552-group-chat-active-run-avatars
impact: Active Agent runs now retain stable room, Agent-record, and run identity across Room switches and reconnects, including exact cleanup when a remote relay disconnects.
pr: 2573
---

# Issue #2552

Group Chat previously kept only the current Room's transient status keyed by Agent display name. That made historical cards for the same Agent indistinguishable from the live run and discarded activity in other Rooms. The server now publishes an authorized activity snapshot and realtime event keyed by `roomId + agentId + runId`; the client replaces that snapshot on reconnect, removes only matching terminal runs, animates only the matching transcript avatar, and shows up to three active avatars plus an overflow count in each local Room row. The active avatars occupy a fixed-width leading slot in place of the old Room bubble icon, so idle and active Room labels remain aligned without an empty placeholder icon. Disconnects, interruptions, Room deletion, context clearing, and Agent removal clear the corresponding transient state. Remote relays preserve the response run identity through terminal cleanup so transport loss cannot leave a stale activity in reconnect snapshots. Reduced-motion users keep a static active outline instead of animation.
