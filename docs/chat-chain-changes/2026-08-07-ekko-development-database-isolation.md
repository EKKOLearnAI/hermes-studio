---
date: 2026-08-07
pr: pending
feature: Restore Ekko development database isolation
impact: Development and production Web UI processes no longer open the same Ekko memory database by default.
---

Ekko Agent development now stores SQLite memory in
`packages/ekko-agent/sql-data/ekko-agent.db`. Production continues to use
`HERMES_WEB_UI_HOME/.ekko/ekko.db`.

The process-level setup reports the resolved environment-specific database path
in its layout and uses that same path for the shared memory store. Ekko config,
skills, logs, and workspaces remain under the configured Web UI base directory.
