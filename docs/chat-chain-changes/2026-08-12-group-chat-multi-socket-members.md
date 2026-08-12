---
date: 2026-08-12
pr: 2498
feature: Group Chat multi-socket member presence
impact: Multiple tabs or browsers for the same authenticated Room member remain joined without invalidating earlier sockets, and presence becomes offline only after the last socket disconnects.
---

Room membership stays deduplicated by user while Socket.IO admission tracks every joined socket for that user.
