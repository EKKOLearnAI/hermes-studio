---
date: 2026-09-05
pr: pending
feature: Restore message reference arrow
impact: Direct-chat and group-chat reference buttons use the familiar reply arrow again; reference behavior is unchanged.
---

Restore the SVG paths used before #2893 at user request. Keep the existing
button dimensions, tooltip, click handler and reference payload intact. Update
both component regression tests to assert the restored icon while retaining
reference-click behavior coverage.
