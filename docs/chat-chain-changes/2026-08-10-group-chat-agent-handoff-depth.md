---
date: 2026-08-10
pr: pending
feature: Room-level Agent handoff depth
impact: Group Chat Rooms can persist bounded, disabled, or unlimited Agent handoff policies and record terminal chains.
---

## Room-level Agent handoff depth

- Adds persisted Room-level automatic Agent handoff settings with explicit
  disabled, bounded, and unlimited semantics.
- Uses `max(4, activeAgentCount + 1)` as a recommendation without silently
  overwriting a saved Room value.
- Persists stopped handoff chains and exposes an owner-only, exactly-once
  continuation endpoint.
- Keeps Mention permissions and the existing human-to-Agent routing unchanged.
