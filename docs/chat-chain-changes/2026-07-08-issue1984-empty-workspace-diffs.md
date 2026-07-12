---
date: 2026-07-08
pr: pending
feature: Empty workspace diff filtering
impact: Workspace run diff cards skip zero-byte content-only changes so empty artifacts do not appear as changed files with +0/-0 counts.
---

The workspace diff tracker now ignores changes where both before and after states are empty and no patch or line delta exists. Non-empty file additions, modifications, and deletions continue to be recorded.
