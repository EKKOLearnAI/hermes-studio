---
date: 2026-06-18
commit: 55a2294e
feature: Workspace folder picker symlink support
impact: Non-hidden symbolic-link directories are now returned by `/api/hermes/workspace/folders`, so Windows junctions and directory symlinks show up in the workspace selector instead of being filtered out.
---
