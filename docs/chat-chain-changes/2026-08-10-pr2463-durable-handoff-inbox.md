---
date: 2026-08-10
pr: "#2463"
commit: pending
feature: durable group-chat handoff inbox
---

# Durable group-chat handoff inbox

- Date: 2026-08-10
- Issue/PR: #2458 / #2463
- Touched feature: durable group-chat continuation delivery
- Behavior impact: source-side delivery receipts now represent only target durable admission. A target inbox keyed by `sourceInstanceId + attemptId` owns admission idempotency, invocation crash recovery, terminal evidence, and source reconciliation. Continue routes return `202` with the stable attempt identity while dispatch proceeds asynchronously.
