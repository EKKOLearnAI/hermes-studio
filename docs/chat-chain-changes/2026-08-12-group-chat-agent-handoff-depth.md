---
date: 2026-08-12
pr: 2504
feature: Room-level Agent handoff depth
impact: Group Chat Rooms can persist bounded, disabled, or unlimited Agent handoff policies and recover continuation delivery through a durable attempt/outbox state machine.
---

## Room-level Agent handoff depth

- Adds persisted Room-level automatic Agent handoff settings with explicit
  disabled, bounded, and unlimited semantics.
- Uses `max(4, activeAgentCount + 1)` as a recommendation without silently
  overwriting a saved Room value.
- Persists handoff chain terminal and continuation state and exposes an
  owner-only continuation endpoint.
- Creates a server-issued attempt identity and durable outbox before delivery;
  target acceptance is atomically deduplicated by attempt ID.
- Records failed delivery as retryable, expires abandoned leases during startup,
  and removes attempts/outbox records when a Room is cleared or deleted.
- Requeues leased `dispatched` attempts after restart and persists target
  delivery receipts so replay of one attempt is idempotent.
- Binds Remote Relay terminal messages to the server-issued invocation context,
  so Relay or Agent-supplied continuation fields cannot complete another
  attempt, while bounded depth up to 100 and explicit unlimited depth follow
  the Room policy instead of a Relay-local cap.
- Converges an invocation interrupted by process restart to an auditable failed
  attempt and retryable stopped chain without replaying the already-started
  invocation.
- Clears every durable handoff chain, attempt, outbox, inbox, and delivery row
  with Room history so no stale Continue action can survive a refresh.
- Ignores Agent-supplied depth and chain fields; only server-issued metadata
  for the exact message may authorize another Agent handoff.
- The client can read stopped-chain depth, target, reason, error, update time,
  and continuation state before retrying.
- Keeps Mention permissions and the existing human-to-Agent routing unchanged.
