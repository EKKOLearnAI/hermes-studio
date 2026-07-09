---
date: 2026-07-09
pr: 2003
feature: Workspace diff SQLite sidecar filtering
impact: Workspace run diff cards skip SQLite WAL/SHM sidecar files so runtime database churn does not appear as +0/-0 changed files.
---

The workspace diff tracker now treats `.db-wal`, `.db-shm`, `.sqlite-wal`, and `.sqlite-shm` as skipped file extensions, matching the existing `.db` and `.sqlite` filtering. User-created text/code files in the same workspace continue to be recorded normally.
