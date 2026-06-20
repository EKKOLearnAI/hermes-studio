---
date: 2026-06-08
pr: pending
feature: Local coding agent launch mode
impact: Global Claude Code/Codex sessions no longer require or send provider credentials; scoped sessions keep the existing provider-backed launch path.
---

- Touched feature: coding-agent chat sessions.
- Change: persist `agent_mode` separately from `provider`, and map it to the client `codingAgentMode`.
- Behavior impact: global Claude Code/Codex sessions no longer require or send provider/model/API credentials; scoped sessions continue to send provider, model, base URL, API key, and API protocol.
- Runtime guard: switching an existing coding-agent session between scoped and global restarts the runner and clears incompatible native session ids so Codex does not resume a previous scoped model thread.
- Validation: focused coding-agent client/server tests and production build.
