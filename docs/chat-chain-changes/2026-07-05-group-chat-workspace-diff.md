---
date: 2026-07-05
pr: pending
feature: Group Chat workspace diff audit messages
impact: Group Chat rooms can persist a validated workspace, workspace-tracked agent runs reserve a Bridge run id before worker start, and bounded workspace diff audit messages stay visible in history while excluded from future model context.
---

Group Chat workspace runs now supply a 32-lowercase-hex Bridge `run_id` and
start the workspace diff checkpoint before `bridge.chat()`. Terminal run states
persist a bounded `workspace_diff` tool message and the workspace run change in
one database transaction.

The persisted diff card renders from the bounded group message payload. No
group-chat lazy workspace diff file-detail endpoint is added.

Windows workspace-folder browsing keeps junction-like entries visible under a
configured `WORKSPACE_BASE`, while room workspace selection, nested folder
browsing, and folder mutation paths still enforce realpath containment before
write-capable use. Create-room compression payloads ignore any unvalidated
workspace field; workspace is set only through the validated room-workspace
route or copied from an existing room during clone. Workspace changes interrupt
active room-agent bridge runs and rotate the room session seed, so a cleared
workspace cannot reuse an older Bridge session with stale terminal cwd overrides.
Room workspace updates reuse
the room/profile visibility gate for non-super-admins, including detail/clone
reads that now expose workspace in room config. Workspace diff finalizers drop
results after room deletion, clear-context interrupts the old room-agent sessions
before rotating the room seed and fences old session generations before late
assistant/tool/diff output can be persisted; agents are not launched for stale
pre-clear generations that lose the race before `bridge.chat`,
interrupt failures do not pre-mark in-flight workspace diffs as aborted, and
persisted workspace-diff audit cards stay visible even when generic tool traces
are hidden. Invite-code room lookup returns no workspace path, invite/member
access remains read-only and workspace-redacted, and management operations
(clone, workspace/config/invite-code updates, agent mutation,
clear/delete/compress) require super-admin, room owner, or profile scope. Socket
join now uses the same invite/member/owner/profile boundary before persisting a
membership row or returning join history, so REST read gates cannot be bypassed
by room-id self-enrollment. Agent rows are persisted before runtime socket join
and rolled back on join failure, so first-time agent joins remain authorized
without leaving failed rows. Realtime management actions such as agent interrupt
and approval response require the same owner/profile/super-admin manage scope,
so invited/read-only members cannot execute tool approvals. Room deletion interrupts
active bridge runs, treats missing room state as stale for pre-launch agent
session fences, then evicts the runtime ChatRoom and Socket.IO room before
deleting persisted data, blocking already-joined sockets from writing orphan
messages after delete and avoiding unaudited post-delete workspace edits. Creator
ownership keeps agentless rooms visible/openable for non-super-admin creators.
Group workspace diff messages and their `workspace_run_changes` rows persist only
the workspace basename, not the absolute workspace path; workspace-change cleanup
uses server-recorded room/message metadata instead of parsing spoofable group
message content for `change_id`. The Group Chat header exposes the validated
workspace picker so room workspace selection is reachable from the shipped UI, and Windows
WORKSPACE_BASE junction-like entries remain browseable after expansion.
