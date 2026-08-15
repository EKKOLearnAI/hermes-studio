---
date: 2026-08-15
feature: pr-2528-pi-review-fixes
impact: Pi group-chat runs now stream text across tool loops, route interactive extension prompts through Studio, and abort before disposal when an Agent is disconnected; Ekko is displayed consistently and can run as a Workflow node.
pr: 2528
---

# PR #2528 Pi review fixes

Pi RPC text deltas are forwarded as they arrive, with authoritative message-end
snapshots used only to append missing suffixes. This preserves assistant text
emitted both before and after tool calls without duplicating it.

Pi extension `confirm` requests use Studio approvals with `once` and `deny`.
`select`, `input`, and `editor` requests use Studio clarifications; unsupported
request/response methods fail closed or are ignored when they are notification-
only operations.

Disconnecting a local group Agent now awaits run abort before session disposal
and transport cleanup. Remote Agent descriptors and pairing codes use protocol
version 2 (`HGC2`) so older peers do not silently accept the new Pi descriptor.

The client now displays the built-in runtime as `Ekko`, with Ekko placed directly
after Hermes in every Agent selector. Workflow nodes persist the stable
`ekko-agent` runtime ID, execute through the existing scoped Ekko path, retain
server-managed provider support, and disable background delegation for the
one-shot Workflow run.
