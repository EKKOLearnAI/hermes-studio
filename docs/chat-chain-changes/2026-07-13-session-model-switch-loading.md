---
date: 2026-07-13
pr: pending
commit: pending
feature: Session model switching
impact: Shows an explicit loading state and prevents duplicate actions while a session model switch is in progress.
---

# Session model switch loading feedback

The session model selector now remains open with a visible loading indicator while the server applies a model change. Model rows, custom model inputs, protocol controls, modal dismissal, and repeated submissions are disabled until the request completes.

Successful switches keep the existing close-and-confirm behavior. Failed switches clear the loading state and leave the selector open so the user can retry.
