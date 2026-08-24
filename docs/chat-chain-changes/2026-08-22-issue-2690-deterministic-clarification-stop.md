---
date: 2026-08-22
pr: pending
feature: Deterministic Group Chat Ekko clarification stop
impact: Force-stop terminally settles the exact Ekko clarification generation without waiting for its normal timeout.
---

Group Chat preserves the Session, visible run generation, and Ekko Runtime run
identity through the internal activity and clarification relays. A force-stop
claims only that exact pending route, aborts through ChatRun, releases the
Runtime waiter, and closes Room/global pending state while rejecting late
responses and leaving unrelated generations untouched.
