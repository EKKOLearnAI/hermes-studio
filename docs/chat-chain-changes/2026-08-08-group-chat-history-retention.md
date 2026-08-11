---
date: 2026-08-08
pr: pending
feature: Group Chat history retention
impact: Group Chat retains older messages without loading more than the latest 500 records into normal UI and Agent context windows.
---

Group Chat no longer deletes older messages automatically when a room exceeds
500 records. Normal UI and Agent context reads stay bounded to the latest 500
messages, avoiding the nested transaction that previously crashed Node 23 when
automatic pruning ran inside a message-save transaction. Explicit clear-history
and delete-room actions continue to remove the room's persisted messages and
related workspace changes.
