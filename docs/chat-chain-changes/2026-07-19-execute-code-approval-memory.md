---
date: 2026-07-19
pr: pending
feature: Execute-code approval memory
impact: Legacy Agent Bridge gateway approvals for execute_code can persist Session and Always choices when descriptive guard pattern keys are emitted.
---

The bridge now carries an execute_code marker from structured gateway approval
tool fields instead of relying only on the literal pattern key.
