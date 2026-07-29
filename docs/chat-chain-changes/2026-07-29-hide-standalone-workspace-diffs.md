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
