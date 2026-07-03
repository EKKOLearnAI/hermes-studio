---
date: 2026-07-03
pr: TBD
feature: Filesystem workspace run diffs
impact: Workspace run diff capture now supports non-Git workspaces with bounded filesystem scanning while preserving existing chat message ordering and run event semantics.
---

Non-Git workspaces now create start/end filesystem snapshots with scan, depth, directory, file, and snapshot byte budgets. Common language dependency and build artifact directories are ignored to reduce noisy workspace diff records. Git workspace behavior remains unchanged.
