---
date: 2026-07-06
commit: pending
feature: Claude Code session model switching
impact: Claude Code scoped sessions now use codingAgentId when deciding whether a model switch needs the API mode chooser. This changes only the client-side configuration prompt and does not alter run transport, message persistence, queueing, or resume semantics.
---

Scoped Claude Code sessions store `agent` as `claude` and `codingAgentId` as `claude-code`. The session model switch flow now normalizes those fields before deciding whether to show the API mode modal.
