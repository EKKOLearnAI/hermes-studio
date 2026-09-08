---
date: 2026-09-05
pr: pending
feature: Confirmed single-item mobile deletion
impact: Calendar/reminder delete requires exact id and title, calendar occurrence time, one-time App confirmation and a bounded deadline.
---

Extends #2892. Delete results must match the requested id and explicitly report
deleted=true. No list/batch/series deletion, profile scope or background access
expansion. Requires the matching App update; older Apps do not support delete.
