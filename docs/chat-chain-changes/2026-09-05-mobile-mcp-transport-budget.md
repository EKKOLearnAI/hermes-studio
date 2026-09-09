---
date: 2026-09-05
pr: pending
feature: Mobile consent transport timeout budget
impact: Keep five-minute consent while allowing HTTP 330 seconds and managed Codex/Grok/Pi tool calls 360 seconds for the terminal result.
---

New/resumed launches must regenerate their managed MCP configuration; an
already-running client does not reload its tool timeout automatically. The
special HTTP transport applies only to mobile-calendar requests and does not
retry writes. Other external MCP servers and location remain unchanged.
