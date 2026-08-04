---
date: 2026-08-04
pr: 2359
feature: Recent direct chats and group activity consistency
impact: Adds a configurable Recent category, preserves categories across forks, mentions quoted senders, and orders group rooms by persisted activity.
---

## Behavior impact

- Direct chat adds a dynamic, non-persisted Recent category ordered strictly by `updatedAt`; its user-level count defaults to 10 and is stored locally.
- `/fork` copies the parent's persisted `category_id` only when the child is created.
- Group-chat quote selection keeps the existing quote card and inserts the quoted valid member's existing `@name` mention syntax once; self, duplicate, and stale members fail closed.
- Group-room list responses include `createdAt` and computed `lastActiveAt`. Persisted non-streaming visible messages drive descending room order, while empty rooms fall back to creation time.
