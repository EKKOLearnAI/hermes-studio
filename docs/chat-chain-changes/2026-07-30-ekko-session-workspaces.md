---
date: 2026-07-30
pr: pending
feature: Profile-scoped Ekko Agent session workspaces
impact: New Ekko Agent sessions without an explicit workspace use an isolated directory under `.ekko/workspace/<profile>/<session-id>`.
---

Ekko Agent initialization now creates its owned `.ekko/workspace` root. Each
profile-scoped global agent creates a profile directory beneath that root and
resolves a dedicated session workspace on demand.

The Ekko chat runtime persists that managed path as the session workspace and
passes it as both `cwd` and `workspaceRoot`. Explicit workspaces remain
authoritative, so existing sessions and user-selected project directories do
not move.
