---
date: 2026-06-07
pr: pending
feature: Hidden Coding Agent runner
impact: Claude Code and Codex can be launched as hidden scoped processes while provider SSE is captured through local proxies for Chat persistence and realtime events.
---

The Coding Agent path stays separate from `api_server` runs. It starts a scoped hidden CLI process, sends Chat input to the process stdin, routes model requests through local Claude/Codex proxies, and recycles hidden sessions after 30 minutes of inactivity or service shutdown.
