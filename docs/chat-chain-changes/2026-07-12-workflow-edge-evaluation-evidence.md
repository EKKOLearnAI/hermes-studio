---
date: 2026-07-12
pr: pending
commit: pending
feature: workflow-edge-evaluation-evidence
impact: workflow runtime and run history
---

# Workflow edge evaluation evidence

- Persists every runtime edge decision as append-only run evidence with deterministic sequence.
- Includes route, status, reason, source, target, and evaluation time in existing run-history responses.
- Records skipped-source propagation and fail-closed evaluation errors, not only taken routes.
- Deletes edge evidence atomically with its workflow run.
