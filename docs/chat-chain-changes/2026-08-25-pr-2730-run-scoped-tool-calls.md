---
date: 2026-08-25
pr: 2730
feature: Run-scoped coding-agent tool calls
impact: Studio now keeps tool calls and reasoning associated with the run that emitted them, so coding agents that reuse tool call IDs no longer overwrite earlier tool cards during streaming, resume replay, or history reconstruction.
---

Tool completion events without a matching start event now create a completed
tool card, preserving calls when a stream reconnects after the start event.
