---
date: 2026-08-26
pr: pending
feature: Server agent module boundaries
impact: Agent contracts and Hermes runtime/provider infrastructure now live behind their owning module boundaries without changing persisted values, endpoints, or chat behavior.
---

Hermes, Ekko, Claude Code, Codex, and Pi keep their existing queue insertion
behavior and wire values. Hermes Agent Bridge, gateway, profile, provider,
conversation, skill-injection, and Studio MCP services now use their canonical
module paths; legacy imports remain compatibility facades during the migration.
