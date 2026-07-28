---
date: 2026-07-28
pr: pending
feature: Ekko production memory
impact: Production Web UI-hosted Ekko sessions now retrieve and maintain the same profile-scoped SQLite memory used outside production.
---

The server no longer forces `memory: false` when `NODE_ENV=production`.
Each production profile initializes Ekko memory under
`HERMES_WEB_UI_HOME/.ekko/ekko.db`, retrieves relevant durable facts before a
foreground model request, and schedules completed turns for the existing
auditable memory extraction flow.

Existing graceful degradation is unchanged: a database initialization failure
still disables memory without blocking chat, and callers can still explicitly
construct an Ekko runtime with `memory: false` for isolated tasks that must not
read or write durable memory.
