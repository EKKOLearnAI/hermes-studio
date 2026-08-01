---
date: 2026-08-01
pr: pending
feature: Ekko-owned compact model request logging
impact: Ekko logs now contain one safe terminal record per model-client request attempt, while runtime events and host persistence events remain out of the profile log.
---

The Ekko runtime owns request logging and the chat host supplies correlation
identifiers only. Each successful or failed foreground, delegated, memory, or
skill-review model-client call produces one compact record containing request shape,
target, timing, outcome, and usage without prompt or response bodies.

Context summarization also runs through an isolated Ekko runtime managed by the
profile's global Ekko instance. Its model call is logged with
`purpose=context-compression` and the originating session ID.

Tool-free model requests no longer carry `toolChoice` internally or serialize
provider-specific `tool_choice` fields. OpenAI Responses, OpenAI Chat,
Anthropic, and custom-runtime payloads preserve tool choice only when they also
contain at least one tool definition.

Socket.IO, queue, compression lifecycle, and database-persistence events are
not copied into the Ekko profile log; existing server diagnostics remain
unchanged. The Logs API uses a read-only Ekko log reader and cannot create or
append profile log files.
