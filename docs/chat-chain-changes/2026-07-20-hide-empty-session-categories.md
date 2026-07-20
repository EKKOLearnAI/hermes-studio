---
date: 2026-07-20
commit: pending
feature: Hide empty session category groups
impact: The chat session sidebar no longer leaves zero-count category headers behind after all visible sessions in a category are deleted or pinned.
---

The category definitions remain available for new-session assignment and later
reuse. Only the sidebar grouping is filtered, so deleting the last session does
not implicitly delete user-managed category data.
