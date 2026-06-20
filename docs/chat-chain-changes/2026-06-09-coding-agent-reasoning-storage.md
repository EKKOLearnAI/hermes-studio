---
date: 2026-06-09
pr: 1443
feature: Coding agent reasoning persistence
impact: Claude Code and Codex reasoning deltas handled by agent-runner now survive server resume, refresh, and DB-backed session reload.
---

- `response-stream` now records `response.reasoning.delta`, `response.reasoning_text.delta`, and `response.reasoning_summary_text.delta` into the active assistant message's `reasoning` and `reasoning_content` fields.
- The response run state keeps a stable reasoning target message so reasoning emitted across tool boundaries follows the same merge behavior as the live client stream.
- `flushResponseRunToDb()` now writes `reasoning` and `reasoning_content` for coding-agent response messages.
- Codex JSONL reasoning items and reasoning delta protocol events are normalized into canonical response reasoning deltas before they are emitted to chat and stored.
- Validation: focused response-stream storage tests and agent-runner utility tests.
