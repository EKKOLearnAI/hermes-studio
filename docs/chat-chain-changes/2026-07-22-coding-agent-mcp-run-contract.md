---
date: 2026-07-22
pr: pending
feature: Fail-closed coding-agent MCP run contract
impact: Coding-agent runs now use a dedicated MCP tool with explicit executor, provider, and model routing, while ordinary chat runs remain compatible.
---

`hermes_studio_use_coding_agent_run` fixes `source` to `coding_agent` and
defaults `mode` to `scoped`. It rejects missing or ambiguous routing fields
before calling the existing `/api/chat-run/runs` bridge.
