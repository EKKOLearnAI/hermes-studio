---
date: 2026-06-15
pr: 1563
feature: Session model hot switch
impact: Session-scoped model changes still persist to the Web UI session row and now notify a loaded Agent Bridge session to switch its cached agent runtime without recreating the session.
---

If the loaded bridge session is busy, the model switch is deferred and applied after the active run completes.
