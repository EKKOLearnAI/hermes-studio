---
date: 2026-08-21
pr: pending
feature: Background callback origin context
impact: Hermes and embedded Ekko background callbacks continue from their originating history instead of unrelated messages added while the task was running.
---

Origin snapshots remain process-local. Embedded Ekko freezes the complete
delegation tool batch; Hermes freezes the completed parent run. A callback with
no available snapshot fails explicitly and never falls back to current session
history.
