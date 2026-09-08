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

2026-09-06 revision: retained inactive conversations no longer block update.
Busy checks inspect actual children/PTY, active turns, queue, pending completion
and interaction state. Async launch preparation and send/compact are locked
against installation. Auto-install waits for 60 seconds of observed safe idle;
activity revisions reset that window, and disabling auto-update cancels waiting.
The prior global-install blanket disabling was withdrawn. Global npm/external
terminal processes and native CLI self-updaters are not fully observable; this
is protection for Studio-managed execution, not a whole-host idle guarantee.
Startup remains lazy and independently updating Hermes Runtime is out of scope
of this revision; keep Draft until the remaining queue/lifecycle/E2E audit.
