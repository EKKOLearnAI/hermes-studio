---
date: 2026-08-23
pr: 2701
feature: Group room avatar active-glow geometry
impact: Running rooms glow the complete rounded-square composite avatar while in-conversation running Agent avatars retain the matching circular rainbow treatment.
---

## Goal

Treat the persistent Group Chat room-list composite as one session avatar while
retaining the established active-Agent rainbow language inside the room.

## Visual contract

- Any running visible or hidden Agent activates one outer glow around the full
  36px room avatar.
- The room-list glow follows a rounded-square silhouette.
- Individual 2x2 member cells and the `+N` overflow cell do not glow.
- In-room running Agent avatars remain circular.
- Both shapes use the existing Direct Chat / Group Chat four-second rainbow
  palette and reduced-motion fallback.

## Non-goals

- No activity identity, roster, avatar, API, persistence, permission, or
  runtime-protocol changes.
