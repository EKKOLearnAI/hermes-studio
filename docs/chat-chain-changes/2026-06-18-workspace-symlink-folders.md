---
date: 2026-06-18
commit: fc1df8d8
feature: Workspace folder picker symlink support
impact: Non-hidden symbolic-link directories are now returned by `/api/hermes/workspace/folders`, so Windows junctions and directory symlinks show up in the workspace selector instead of being filtered out.
---
