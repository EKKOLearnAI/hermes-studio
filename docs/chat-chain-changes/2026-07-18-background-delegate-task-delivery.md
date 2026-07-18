---
date: 2026-07-18
pr: 2126
feature: Background delegate task delivery
impact: Background subagent telemetry remains visible after the parent turn ends, and durable completion notifications start a new parent turn without adding child tool traffic to the parent context.
---

Agent Bridge workers expose one background event and completion poll each. The
Node chat runtime uses one scheduler across workers, while the client keeps one
session-scoped Socket handler alive until all background delegations have been
delivered. Worker recovery accepts recent session ownership routes so pending
completion records restored from Hermes `state.db` can be claimed safely.
Graceful shutdown now closes the chat scheduler before the bridge, releases
queued delivery claims, interrupts active parent and delegated runs, and kills
tracked tool subprocess trees before worker exit.
The existing session Stop action also interrupts only that session's active
background delegations alongside its parent Hermes run.
Background task cards and the active tool strip open the same resizable side
panel used by file and PDF previews. Its body reuses the chat message list and
message renderer for live subagent text, reasoning, and tool calls; lifecycle
status remains in the panel header instead of appearing as transcript content.
Background parent dispatch events and `delegation.updated` lifecycle records do
not create placeholder cards, so each visible entry is keyed by a real
`subagent_id` and always opens the corresponding live stream.
