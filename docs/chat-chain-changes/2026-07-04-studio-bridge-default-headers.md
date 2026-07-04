---
date: 2026-07-04
pr: 1931
commit: 3bcbdd64
feature: Studio agent bridge default headers
impact: Investigation showed stale desktop runtime caches can keep Studio on an older Hermes Agent runtime; Studio now relies on runtime 0.18.0+ for `model.default_headers` instead of bridge monkey patches.
---
