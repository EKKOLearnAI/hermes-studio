---
date: 2026-08-08
pr: pending
feature: Group Chat tool-result mention isolation and terminal recovery
impact: Treats Tool payload text as non-routable data, preserves owner-only conversational @all authorization, and retains completed Tool results for collision-resistant idempotent Room-persistence retry with bounded message IDs, ACK timeouts, and replay suppression until they are acknowledged.
---

Group Chat no longer interprets literal mention text found in Tool output as routing intent. Tool-result persistence uses a stable message identity and keeps its correlation and original completion payload until Room storage acknowledges it, allowing both Hermes and Coding Agent run finalization to reconcile transient failures without leaving reloaded Tool cards permanently running. Explicit Agent client teardown clears any remaining in-memory Tool recovery and replay state.

Persisted Tool call/result row IDs keep their existing readable form when it fits the Room server's 160-character client-ID limit. Longer composite IDs retain their ordering marker and use a deterministic digest of the full Run, message kind, and external Tool call ID, so an ACK retry addresses the same row without altering the `tool_call_id` shared with the model runtime.
