---
date: 2026-06-08
pr: pending
feature: Coding-agent tool output storage
impact: Claude Code and Codex tool results are truncated before SQLite storage to limit database growth.
---

- Scope: Claude Code and Codex runs handled by `agent-runner`.
- Change: truncate `function_call_output` before it enters the shared response stream state and SQLite flush path.
- Limit: keep the first 24 KiB and last 8 KiB of large tool results, with a storage truncation marker in the middle.
- Non-goals: regular Hermes chat, assistant text, user messages, and tool call arguments are unchanged.
