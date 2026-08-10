---
date: 2026-08-10
pr: "#2463"
commit: pending
feature: durable group-chat handoff outbox replay
---

# Durable group-chat handoff outbox replay

- Date: 2026-08-10
- PR/commit: PR #2463
- Touched feature: Group Chat durable Agent handoff continuation
- Behavior impact: Continuation requests are persisted in `gc_handoff_outbox` and
  consumed by a lease-based dispatcher. Restart recovery replays pending work,
  target acknowledgements are idempotent, and bounded failures leave an
  auditable stopped chain instead of a permanently claimed continuation.
