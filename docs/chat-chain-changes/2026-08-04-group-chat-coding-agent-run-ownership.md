---
date: 2026-08-04
pr: pending
feature: Group Chat Coding Agent run ownership
impact: Group Chat no longer imposes a fixed two-minute absolute deadline on Codex, Claude Code, or Ekko runs; runtime-owned request and execution controls remain authoritative.
---

The non-Hermes Group Chat adapter no longer passes `timeoutMs: 120000` to
`runAndWait()`. Active Coding Agent turns are therefore not aborted solely
because the complete room turn exceeds two minutes. Explicit Room interruption,
Session cleanup, tool-event persistence, and Workspace Diff finalization remain
unchanged.

Hermes Agent Bridge request timeouts, HTTP chat-run behavior, Workflow timeout
behavior, and ordinary single-chat Coding Agent behavior are unchanged.
