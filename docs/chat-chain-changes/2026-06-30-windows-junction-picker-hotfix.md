---
date: 2026-06-30
pr: 1868
feature: Windows workspace junction folder picker hotfix
impact: Windows workspace folder picker can list and browse directory junction/symlink entries whose real target is outside WORKSPACE_BASE, matching the C:\\Drives\\D -> D:\\ workflow, while create/rename/delete operations keep realpath containment checks.
---

Hotfix after #1854: listing/browsing follows Windows directory junctions for the picker; mutation paths remain guarded.
