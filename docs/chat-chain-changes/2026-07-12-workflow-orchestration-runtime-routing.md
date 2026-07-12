---
date: 2026-07-12
pr: TBD
commit: pending
feature: Declarative workflow runtime routing
impact: Workflow runs now evaluate explicit success, failure, and always edge routes; unhandled failures remain fail-fast and untaken branches are marked skipped.
---

- Validates the declarative graph before creating a run or dispatching an Agent.
- Continues only when an explicit failure handler actually consumes the failure; skipped or already-running targets preserve fail-fast behavior.
- Applies legacy `all` joins and explicit `any` joins, and propagates skipped branches without depending on node array order.
- Fails the run when an edge condition cannot be evaluated safely.
