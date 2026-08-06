---
date: 2026-08-06
pr: pending
feature: Coding Agent tool start event coalescing
impact: Streaming Coding Agent tool arguments are buffered server-side and produce one tool.started event with complete arguments, preventing per-delta Group Chat persistence and Socket acknowledgements while preserving immediate starts for native events that already contain complete arguments.
---

Coding Agent Responses streams no longer translate every
`response.function_call_arguments.delta` into another client-facing
`tool.started` event. The deltas still update the in-memory function call so the
complete arguments remain available for message persistence and tool result
association.

When `response.output_item.added` has empty arguments, the tool start is emitted
once from `response.output_item.done` with the completed argument object. Native
Claude Code and Codex events that already provide complete arguments continue
to emit one start immediately. Tool completion, failure, duration, and stored
assistant/tool messages are unchanged.
