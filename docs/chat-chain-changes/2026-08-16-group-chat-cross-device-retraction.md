---
date: 2026-08-16
pr: pending
feature: Cross-device queued message retraction
impact: An authenticated account can retract its own still-queued Group Chat message from another device without sharing a browser-local capability.
---

Unauthenticated members still require the original per-device capability, and a different authenticated account cannot retract the message even if it has that capability.
