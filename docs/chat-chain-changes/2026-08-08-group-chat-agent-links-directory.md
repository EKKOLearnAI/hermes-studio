---
date: 2026-08-08
pr: pending
feature: Group Chat Agent link state directory
impact: Outbound Group Chat Agent links are stored with the rest of the Group Chat state.
---

`group-chat-agent-links.json` now lives under
`HERMES_WEB_UI_HOME/group-chat/` instead of the Web UI state root. Existing
root-level files are intentionally not migrated.
