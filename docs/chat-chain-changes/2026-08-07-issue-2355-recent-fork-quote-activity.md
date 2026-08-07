---
date: 2026-08-07
feature: issue-2355-recent-fork-quote-activity
impact: Adds a dynamic persisted Recent group for direct chats, snapshots real categories when forking, creates validated structured quote mentions, and unifies durable visible-message room activity ordering.
pr: pending
---

# Issue #2355

Recent never writes a category ID; forks copy only the parent real `category_id`. Group-chat quote cards are retained while the quoted valid participant is sent through the structured mention protocol. Agent reply generation excludes its own participant ID before building structured routing metadata, while server-side self-mention rejection remains the defense-in-depth boundary. Room list responses expose the server-computed `lastActiveAt` for every visibility path, so client refresh sorting preserves durable visible-message activity. Legacy group activity uses a durable one-time migration cutoff, ignores tool and streaming messages, and falls back to room creation time when empty.
