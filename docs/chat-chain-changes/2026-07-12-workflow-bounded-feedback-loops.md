---
date: 2026-07-12
pr: pending
commit: pending
feature: workflow-bounded-feedback-loops
impact: workflow compiler, runtime, persistence, history, and edge policy editor
---

- Adds declarative bounded feedback edges with required conditions and `maxIterations` from 1 to 100.
- Rejects unmarked cycles, fake feedback markers, multi-entry regions, and ambiguous overlapping loop regions before a run is created.
- Supports disjoint and strictly nested loop regions with deterministic outer-to-inner iteration identities.
- Re-dispatches every loop iteration with fresh sessions, carries feedback output into the next pass, and fails before exceeding the configured limit.
- Persists iteration paths for node sessions and edge evaluation evidence, including additive migration for legacy databases.
- Adds edge editor controls for enabling feedback loops and setting their maximum iterations without losing existing declarative policy data.
