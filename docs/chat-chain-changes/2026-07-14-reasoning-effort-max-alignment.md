---
date: 2026-07-14
pr: 11
feature: Maximum reasoning effort alignment
impact: Chat, scoped coding-agent runs, and Workflow nodes expose and preserve the same `max` reasoning effort end to end.
---

The Chat selector now exposes `max` alongside Workflow authoring. The per-session choice is persisted and forwarded as `reasoning_effort: "max"`; Responses and Anthropic protocol adapters preserve it, and the scoped Codex model catalog declares it as supported.

`max` is the highest single-model reasoning effort accepted by the active Hermes Agent runtime. It is distinct from Codex Ultra multi-agent mode and is never silently downgraded to `xhigh`.
