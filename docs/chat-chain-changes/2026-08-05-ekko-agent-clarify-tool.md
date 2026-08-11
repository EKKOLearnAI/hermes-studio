---
date: 2026-08-05
pr: 2368
feature: Ekko Agent clarification tool
impact: Foreground Ekko chat runs can pause for one free-text or multiple-choice clarification using the existing Hermes chat interaction card and Socket.IO response path.
---

Ekko's default tool registry now exposes `clarify` only when the foreground
host provides an interactive clarification callback. The tool accepts one
question and optional string choices, waits up to five minutes, and returns the
user's response to the same model run. Delegated subagents and non-interactive
hosts do not receive the tool. When the tool is present, Ekko's system prompt
requires blocking clarification questions to use it instead of returning a
plain assistant message that cannot pause and resume the run.

The Web UI server brokers pending Ekko clarifications by session and forwards
them through the existing `clarify.requested`, `clarify.respond`, and
`clarify.resolved` events. The current Hermes clarification card therefore
renders Ekko questions without a new client component or protocol. Abort,
timeout, shutdown, duplicate-pending, and cross-session cases resolve without
leaving a stale blocking prompt.
