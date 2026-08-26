---
date: 2026-08-26
pr: pending
feature: Studio chat surface module ownership
impact: Runtime behavior and public HTTP/Socket.IO protocols are unchanged.
---

Moved Single Chat, Group Chat, Workflow, Global Agent, and cross-agent webhook
orchestration under the Studio server module. Concrete Hermes, Ekko, Claude Code,
Codex, and Pi integrations are composed through bootstrap runtime ports; legacy
server paths remain compatibility facades during the migration.
