---
date: 2026-07-23
pr: pending
feature: Hide unattributed single-chat workspace diffs
impact: Workspace changes without an assistant message ID no longer render as legacy cards near the end of chat history.
---

Single-chat workspace diff rendering now requires a non-empty
`assistant_message_id`. Unattributed historical changes are ignored instead of
being restored onto tool messages or inserted as timestamp-based synthetic cards.

Changes that do contain an assistant message ID keep the existing pagination
behavior: if the referenced message is not loaded yet, the temporary standalone
card can remain until that exact assistant turn is loaded and the diff is attached
to it.

This is a client projection change only. Workspace diff collection, persistence,
server APIs, and attributed historical records are unchanged.
