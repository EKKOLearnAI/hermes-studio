---
date: 2026-09-06
pr: 2923
feature: Host-scoped coding Agent update policy
impact: Admin-only shared settings control checks-only by default and opt-in idle installation; new launches are rejected while the managed update lock is held.
---

Current implementation initializes after the first admin policy request, checks
at six-hour intervals and waits conservatively for all managed sessions of the
Agent to close. It does not monitor external terminal processes or reconcile
native self-updaters, and does not independently update Hermes Runtime/Ekko.
Keep this PR draft until those boundaries and initial lifecycle are completed.
