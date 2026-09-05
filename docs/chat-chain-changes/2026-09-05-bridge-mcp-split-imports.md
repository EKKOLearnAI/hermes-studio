---
date: 2026-09-05
pr: pending
feature: Agent Bridge MCP Runtime import compatibility
impact: Restore MCP management and shutdown on split-module runtimes and avoid deprecated discovery aliases during chat startup.
---

Prefer the Runtime's `mcp_tool_loop` and `mcp_tool_discovery` modules, while
retaining fallback imports for older runtimes where those modules are absent.
Keep shared server state in `mcp_tool`. Do not fall back when a split module
exists but fails to import a dependency. Missing MCP runtimes retain the
existing config-only listing behavior.

No configuration migration or Runtime source patch is required. Running bridge
workers must be restarted after deployment to load the updated Python code.
