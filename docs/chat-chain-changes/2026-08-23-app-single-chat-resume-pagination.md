---
date: 2026-08-23
pr: pending
feature: App single-chat resume pagination
impact: Direct-chat resume snapshots now stay bounded to the latest 150 display messages while runtime history and model-context construction remain complete.
---

The App can request older persisted messages through the existing paginated
conversation endpoint. Resume pagination is applied only when building the
outbound display payload; it does not trim session runtime state, persisted
messages, compression snapshots, or the database-backed model history.
