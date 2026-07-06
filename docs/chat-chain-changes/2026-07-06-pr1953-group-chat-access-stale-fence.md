---
date: 2026-07-06
pr: 1953
feature: Group Chat workspace access and stale Bridge run fencing
impact: Group Chat room creation can set a validated workspace up front, read-only room access no longer exposes invite codes or workspace mutation controls, agent sockets cannot perform realtime management actions, and clear/delete/workspace changes fail fast when active Bridge interrupts are not synchronized.
---

Group Chat room creation now exposes the same shared `FolderPicker` workspace
selection pattern as single-chat creation. The server accepts only a top-level
`workspace` field, validates it through the workspace route validator before the
room row is created, and still ignores any hidden workspace value inside the
compression config payload.

Group Chat room serialization now includes an explicit `canManage` flag and redacts
`inviteCode` and `workspace` for invite/member read-only access. The client uses
that manage flag to hide and no-op management-only controls, including workspace
selection, compression configuration, add/remove agent, clear context, delete, and
clone.

Runtime agent sockets remain allowed to join their persisted room, but they are
not treated as room managers for realtime management events such as
`interrupt_agent` and `approval.respond`.

Room delete, clear-context, and workspace-switch routes now stop before mutating
persistent room state if active room-agent Bridge sessions report an unsynchronized
interrupt. Late Bridge completions are fenced before usage/cost rows are recorded,
so cleared or deleted room generations do not accrue stale run usage after their
messages/diffs are rejected. Long Bridge session ids keep a bounded hash of the
room session seed in the retained suffix, so room-generation freshness checks do
not lose the seed when room/profile/agent names are long. Best-effort status emits
after a synced interrupt no longer turn that successful interrupt into a route
409 when an agent socket is temporarily disconnected, and idle agents whose
Bridge session was never opened report as already synchronized instead of blocking
room workspace changes, clear-context, or delete-room.
