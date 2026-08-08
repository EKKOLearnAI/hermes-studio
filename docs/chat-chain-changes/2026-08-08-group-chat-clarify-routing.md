---
date: 2026-08-08
pr: 2406
feature: Group Chat clarification routing
impact: Hermes and Ekko Group Chat clarification requests now reach room managers once and require an explicit response before the run continues.
---

Group Chat owns the approval and clarification lifecycle for its runs. Generic
`/chat-run` pending-interaction delivery ignores `group_chat` sessions so the
same request is not also shown under an internal run ID. Pending room actions
are restored for authorized managers when they reconnect. Snapshot recovery
also treats missing transient route maps as empty during partial server setup.
