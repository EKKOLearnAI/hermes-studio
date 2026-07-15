---
date: 2026-07-04
pr: 1925
feature: Ekko Agent chat runtime
impact: Ekko Agent runs through an explicit `ekko-agent` coding agent branch while existing Hermes, Group Chat, workflow, Claude Code, and Codex dispatch paths keep their prior behavior.
---

The server now dispatches runs with `coding_agent_id` or `agent_id` set to
`ekko-agent` into a dedicated Ekko Agent runtime handler. The client can
recognize existing Ekko Agent sessions and display their logo, but the new-chat
Ekko Agent selector entry remains hidden until the entry point is ready to
ship. The existing Hermes bridge and Claude/Codex coding-agent handlers continue
to handle their previous inputs.
