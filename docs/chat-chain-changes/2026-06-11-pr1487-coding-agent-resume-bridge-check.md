---
date: 2026-06-11
pr: 1487
feature: Coding agent resume bridge checks
impact: Coding agent session resume no longer depends on Hermes worker status lookup, while Hermes worker-backed sessions still attempt bridge reattach.
---

Transient Hermes bridge status lookup timeouts during resume are logged at debug level instead of being emitted as user-visible reattach warnings.
