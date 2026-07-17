---
date: 2026-07-17
pr: pending
feature: Agent Bridge worker readiness
impact: Worker startup consumes a queued ready event before reporting that the worker exited before readiness.
---

This preserves the existing failure for workers that exit without reporting ready,
while avoiding a false startup failure when stdout already contains the ready
handshake.
