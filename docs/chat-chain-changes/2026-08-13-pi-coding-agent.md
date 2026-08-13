---
date: 2026-08-13
pr: pending
feature: Pi Coding Agent integration
impact: Hermes Studio can manage and run Pi in RPC mode with scoped provider routing and four lazy Studio MCP servers through pi-mcp-adapter.
---

# Pi Coding Agent integration

- Adds Pi as a managed Coding Agent backed by `@earendil-works/pi-coding-agent` RPC mode.
- Installs and pins `pi-mcp-adapter@2.24.0` in the Hermes Web UI managed home.
- Generates per-run Pi `settings.json`, `models.json`, `mcp.json`, `APPEND_SYSTEM.md`, and session storage.
- Exposes the four Hermes Studio MCP stdio servers as lazy direct tools.
- Uses the existing short-lived scoped provider proxy and model-run token flow.
- Streams strict LF-framed Pi JSONL events into the existing canonical chat event pipeline and completes on `agent_settled`.
