---
date: 2026-08-23
pr: 2702
feature: Workspace file links with source locations
impact: Chat file previews now remove trailing line and column locations before reading local workspace files.
---

Markdown links such as `/workspace/file.ts:120` and
`C:/workspace/file.ts:120:8` now preview the underlying file instead of treating
the source location as part of its filename. Download behavior uses the same
normalized path.
