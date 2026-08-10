---
date: 2026-08-10
pr: pending
feature: Room-level Agent handoff depth
impact: Group Chat Rooms can persist bounded, disabled, or unlimited Agent handoff policies and recover continuation delivery through a durable attempt/outbox state machine.
---

## Room-level Agent handoff depth

- Adds persisted Room-level automatic Agent handoff settings with explicit
  disabled, bounded, and unlimited semantics.
- Uses `max(4, activeAgentCount + 1)` as a recommendation without silently
  overwriting a saved Room value.
- Persists stopped handoff chains and exposes an owner-only continuation endpoint.
- Creates a server-issued attempt identity and durable outbox before delivery;
  target acceptance is atomically deduplicated by attempt ID.
- Records failed delivery as retryable, expires abandoned leases during startup,
  and removes attempts/outbox records when a Room is cleared or deleted.
- The client can read stopped-chain depth, target, reason, error, update time,
  and continuation state before retrying.
- Keeps Mention permissions and the existing human-to-Agent routing unchanged.
