---
date: 2026-07-05
pr: pending
feature: Group Chat workspace diff audit messages
impact: Group Chat room-agent workspace runs persist bounded workspace_diff audit cards using Bridge-assigned run ids, exclude those audit cards from future model context, and fence stale or aborted run output before it can be saved.
---

Group Chat workspace runs now start a workspace diff checkpoint after Agent
Bridge returns its canonical `run_id`. WUI does not supply or override Bridge
run ids; the persisted audit row and tool-style room message follow the
Bridge-assigned run id.

When a room-agent run finishes, the server persists the bounded
`workspace_diff` message and matching `workspace_run_changes` row in one
database transaction. The persisted payload stores only the workspace basename,
keeps bounded file summaries and patches for the chat card, and avoids adding a
lazy group-chat file-detail endpoint.

Workspace diff audit messages are excluded from future Group Chat model context
and context token estimates, while still rendering as visible audit cards even
when generic tool traces are hidden. Client-supplied `workspace_diff` tool rows
are sanitized so only server-created audit cards keep that protected tool name.

Clear-context, delete-room, workspace-switch, and interrupt flows now fence the
current room-agent Bridge session before stale assistant/tool/workspace-diff
output can be persisted. Synchronized interrupts can finalize in-flight
diffs as aborted, unsynchronized interrupt failures leave the diff state
pending, and room interrupt pauses mention-queue draining so a queued mention
cannot start a new old-workspace run while the room is being reset.
