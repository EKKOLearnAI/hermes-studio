---
date: 2026-06-08
pr: pending
feature: Coding-agent Codex response stream
impact: Codex final assistant messages after tool execution are no longer dropped as duplicate output.
---

- Touched feature: coding-agent chat sessions.
- Change: Codex `agent_message` completion text that differs from prior streamed text is appended only when the current run most recently emitted a tool boundary.
- Behavior impact: turns with an opening assistant message, tool execution, and a distinct final answer persist both assistant messages while still deduplicating replayed Codex snapshots.
- Validation: focused agent-runner Vitest coverage.
