---
date: 2026-06-29
pr: 1838
feature: History archive state merge
impact: History rows sourced from Hermes state.db now preserve Web UI local archive state so imported CLI/API sessions can be unarchived.
---

When a session exists in both Hermes `state.db` and the Web UI local store, the history listing keeps the state.db summary but overlays the local `is_archived` flag used by the History unarchive menu.
