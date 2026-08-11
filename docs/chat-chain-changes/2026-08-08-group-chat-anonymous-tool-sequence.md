---
date: 2026-08-08
pr: pending
commit: pending
feature: group-chat anonymous tool result correlation
impact: prevents anonymous Tool call/result ID reuse and persisted-row overwrite
---

Anonymous Tool calls without native IDs now receive collision-resistant identities derived from Room/Session/Run scope plus a monotonic AgentClient sequence. Sequential acknowledged same-name calls remain distinct even when wall-clock time does not advance, preventing persisted Tool call/result rows from overwriting earlier rows.
