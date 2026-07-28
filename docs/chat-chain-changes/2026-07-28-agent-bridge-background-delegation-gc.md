---
date: 2026-07-28
pr_or_commit: pending
feature: Agent Bridge background delegation idle GC
impact: Agent Bridge idle-session cleanup now preserves sessions that still own running or finalizing background delegations.
---

The worker checks durable async delegation state before destroying a session
that has exceeded the 30-minute idle timeout. If that registry is temporarily
unavailable, it falls back to the worker's background task telemetry. Sessions
without active background work continue to be reclaimed normally.
