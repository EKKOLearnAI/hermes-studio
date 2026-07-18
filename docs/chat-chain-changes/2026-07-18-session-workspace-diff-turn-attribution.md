---
date: 2026-07-18
issue: "#2079"
pr: 2127
feature: Session workspace diff turn attribution
impact: Workspace changes persist their exact Assistant-message association so live and reloaded sessions render each diff under the response that produced it.
---

Session-scoped legacy workspace paths are normalized without changing generic file APIs. Run checkpoints suppress zero-line noise, repair historical parent aggregates idempotently, and retain a standalone fallback only for legacy change records that have no persisted Assistant association.

The server records the database Assistant message ID with each workspace change and rebinds the matching in-memory message to that ID before it can be returned by session resume. The live chat aligns its temporary Assistant ID to the same persisted ID, and history reloads attach the change records to the exact Assistant turn. Group chat retains its durable workspace-diff audit message while using the persisted parent Assistant message ID to render that diff inside the exact Agent reply for live and reloaded rooms.
