---
date: 2026-08-21
pr: 2650
feature: Preserve explicit New Chat selection
impact: A stale session-list load can refresh metadata without replacing or dropping a newer local-only chat.
---

Session-list reconciliation now keeps local-only chats until their first run is
persisted and yields active-session ownership to any newer user selection.
