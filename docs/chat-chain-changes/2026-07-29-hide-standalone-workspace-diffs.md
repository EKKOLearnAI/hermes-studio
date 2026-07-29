---
date: 2026-07-29
pr: pending
feature: Assistant-only workspace diff rendering
impact: Single-chat and group-chat file diffs never render as standalone cards.
---

Workspace diff projection now has one rule across restored history, pagination,
and realtime updates: a diff is visible only when its persisted Assistant
message ID resolves to an Assistant message currently loaded in the client.

Single chat no longer creates synthetic `workspace-run-change:*` messages or
attaches workspace changes to tool messages. Group chat continues to persist
`workspace_diff` audit messages, but always removes those raw tool messages from
the visible projection; an exact `parent_message_id` match moves the payload
under the Assistant response, while missing or not-yet-loaded parents keep it
hidden until a later projection can resolve the association.

The built-in Ekko Agent now uses the same workspace checkpoint lifecycle as
the Codex and Claude Code agents. It starts tracking from the runtime's
`run.started` ID, persists changes on completion, failure, or abort, and binds
successful changes to the exact persisted Assistant message ID before emitting
the realtime and terminal run payloads.
