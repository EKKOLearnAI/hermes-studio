---
date: 2026-07-30
pr: 2226
feature: Group Chat terminal status publication
impact: A durably accepted final handoff message now atomically drives stream completion and clears the participant's replying status without weakening stale callback fences.
---

- The server publishes `message_stream_end` and `context_status=ready` only after the exact final message commit consumes the current handoff lease.
- Later Agent callbacks carrying the consumed lease remain rejected, so stale Sessions cannot clear a newer run's state.
- Replayed final messages do not rebroadcast terminal UI events.
