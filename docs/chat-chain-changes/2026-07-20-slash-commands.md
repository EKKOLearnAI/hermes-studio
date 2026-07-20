---
date: 2026-07-20
pr: 2152
feature: slash-commands
impact: |
  - slash-command dispatch: agent-bridge now resolves skill bundles and skill
    commands via agent.skill_bundles and agent.skill_commands, mirroring the
    gateway's dispatcher. Previously unknown /-prefixed messages were sent as
    plain user text.
  - slash-command autocomplete: new GET /api/hermes/slash-commands endpoint
    serves installed skill bundles; ChatInput.vue fetches bundles and skills
    on mount, merging them into the autocomplete dropdown alongside built-in
    commands. Previously only hardcoded commands appeared.
---

