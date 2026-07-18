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
background delegations alongside its parent Hermes run. Interrupted child task
snapshots and cards now receive an explicit terminal event, with the client also
settling any still-running card when abort completion arrives, so a silent child
shutdown cannot leave a permanent loading indicator.
Background task cards and the active tool strip open the same resizable side
panel used by file and PDF previews. Its body reuses the chat message list and
message renderer for live subagent text, reasoning, and tool calls; lifecycle
status remains in the panel header instead of appearing as transcript content.
Background parent dispatch events and `delegation.updated` lifecycle records do
not create placeholder cards, so each visible entry is keyed by a real
`subagent_id` and always opens the corresponding live stream.
Agent callers may pass `background_delegation_enabled=false` when the Bridge
creates a cached Hermes `AgentSession`. The value is retained in that session's
configuration; later turns bind `async_delivery` from the creation policy
instead of treating it as a mutable per-run setting. This keeps synchronous
`delegate_task` available while background requests fall back to the current
turn. Ordinary Web UI single-chat agents are currently created disabled.
Group-chat agents and Hermes workflow-node agents pass the same disabled policy
at their own creation call sites and remain disabled independently of any
future single-chat opt-in. Coding Agent and Ekko Agent paths do not receive the
field. The bridge filters session-context arguments against the installed
Hermes Runtime signature, so the bundled 0.18.0 context API keeps receiving its
supported legacy fields while 0.18.2 and newer receive the session-level
async-delivery capability. Agent Bridge retains Hermes Runtime's `tui`
session-source contract because background delegation uses that path to bind
completion ownership to the durable agent session across compression-driven
session-id rotation.
