---
date: 2026-07-01
pr: 1871
commit: 3e82cf10
feature: Desktop MCP shutdown
impact: Desktop bridge shutdown now asks profile workers to close registered MCP servers before terminating worker processes.
---

Bundled Hermes Studio MCP configs generated for Web UI injection and coding-agent launches now prefer the packaged runtime node from `HERMES_AGENT_NODE` when it is available. This keeps desktop MCP subprocesses on the managed runtime while preserving the existing `process.execPath` fallback outside desktop runtime.
