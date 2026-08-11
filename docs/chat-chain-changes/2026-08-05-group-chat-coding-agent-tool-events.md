---
date: 2026-08-05
pr: pending
feature: Group Chat Coding Agent tool event authority
impact: Claude Code and Codex group turns no longer persist duplicate proxy tool calls beside their authoritative native tool lifecycle, Responses-backed Claude tools keep one stable call identity with compatible optional arguments, and failed tools retain their error state.
---

While a Claude Code print child is active, its native stream-json
`tool_use`/`tool_result` events are now the only tool lifecycle authority.
Responses proxy tool events for that same child are ignored because they can use
different call ids and omit the matching output event, which previously left
duplicate Group Chat tool cards loading until the full agent turn completed.

Codex keeps proxy text deltas for responsive streaming, but its JSONL events are
now the sole authority for command, MCP, web search, and file-change tool
lifecycles. This extends the existing `exec_command` deduplication to every
Codex tool and its completion event.

Group Chat tool result messages now also persist `finish_reason: error` for
failed events so client projection renders the card as failed rather than
successfully completed.

The Claude Code Responses bridge now treats a Responses function item's
`call_id`, `item_id`, and `output_index` as aliases for one tool block. This
prevents argument-delta events from creating a second tool named `tool` that
cannot receive the real call's result. The bridge buffers each complete
argument object and uses the original Anthropic tool schema to remove unused
empty values only from optional fields before Claude Code validates the call;
required values and explicitly allowed empty or null values are preserved.
