---
date: 2026-08-10
pr: 2463
feature: Durable group-chat handoff lease recovery
impact: Expired dispatching outbox leases are reclaimable by the dispatcher without requiring a process restart; tests cover runtime lease recovery and restart-to-dispatcher replay through the real service path.
---
