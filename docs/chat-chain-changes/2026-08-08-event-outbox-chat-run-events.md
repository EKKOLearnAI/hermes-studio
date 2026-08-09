---
date: 2026-08-08
feature: event-outbox-chat-run-events
impact: Bridge runs record chat.run.completed and chat.run.failed in a durable outbox after the run result is flushed; delivery is opt-in, happens off the run path, and carries identifiers and counts only.
pr: 2418
---

# Event outbox: chat run events

`handleBridgeRun` publishes one outbox event at the terminal point of a run, immediately after `flushBridgePendingToDb`, `updateSessionStats` and the usage/context refresh have run and after the socket payload is emitted. Publishing is a local SQLite insert guarded against throwing, so a failing outbox cannot fail or delay a run, and no `completed` event can be observed before the run result is persisted. The dedupe key is `chat.run.<state>:<session_id>:<run_id>`, which makes a replayed or retried run collapse onto the existing event row instead of emitting twice. Delivery is handled by a separate dispatcher on its own interval and touches nothing in the chat chain. With no webhook endpoint configured the publish call records an event with zero deliveries and nothing leaves the instance.
