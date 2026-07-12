---
date: 2026-07-09
pr: 2003
feature: Workspace diff SQLite sidecar filtering
impact: Workspace run diff cards skip SQLite WAL/SHM sidecar files and continue scanning past unchanged files so newly created ordinary files are not hidden by the changed-file cap.
---

The workspace diff tracker now treats `.db-wal`, `.db-shm`, `.sqlite-wal`, and `.sqlite-shm` as skipped file extensions, matching the existing `.db` and `.sqlite` filtering. It also applies the changed-file cap after detecting actual changes instead of slicing the candidate path list first, so newly created ordinary text/code files in large non-git workspaces continue to be recorded normally.
