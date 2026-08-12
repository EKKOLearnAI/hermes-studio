---
date: 2026-08-12
pr: 2500
feature: Group Chat multi-socket typing ownership
impact: Preserve socket-owned typing state across same-user connections
---

## Summary

Typing state now records the joined socket that most recently emitted `typing` for a room member. A disconnect or `stop_typing` event clears that state only when it comes from the owning socket, so another same-user tab or device cannot prematurely remove an active typing indicator.

## Impact

- Preserves active typing when a different joined socket for the same user disconnects.
- Ignores stale `stop_typing` events from non-owning same-user sockets.
- Keeps owner disconnect cleanup and the existing joined-room authorization checks.

## Notes

This is a transient server-side lifecycle fix following #2498. It does not change persisted Room membership, message history, or authorization policy.
