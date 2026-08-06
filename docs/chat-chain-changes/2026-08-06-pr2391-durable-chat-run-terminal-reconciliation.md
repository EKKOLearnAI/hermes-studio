---
date: 2026-08-06
pr: 2391
feature: Durable Chat Run terminal reconciliation
impact: Chat Run completion is correlated to one server-internal invocation and persisted for event-loss reconciliation without changing the one-message Group Chat reply contract.
---

- Touched feature: HTTP Chat Run, Workflow/Hermes runs, and scoped Coding Agent terminal delivery.
- Change: add a durable invocation ledger, exact terminal-event fencing, and event-first completion with SQLite fallback.
- Behavior impact: attachment timeout detaches only the caller, while execution deadlines and explicit cancellation still stop the child; late terminal events cannot settle another invocation.
- Action handling: `requires_action` remains durable and can later converge to a terminal state; approval errors fail durably, release the Session fence, and interrupt the Bridge.
- Security boundary: persisted Session Profile remains authoritative, user access is enforced, and caller-provided invocation IDs are discarded at the HTTP boundary.
- Recovery boundary: active invocations fail closed after server restart; restoring an already-lost parent model/tool stack remains outside this change.
- Validation: focused lifecycle/controller/Coding Agent tests, repository harness check, production build, and exact-head GitHub CI.
