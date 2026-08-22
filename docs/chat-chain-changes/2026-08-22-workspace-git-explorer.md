---
date: 2026-08-22
pr: 2674
feature: Workspace Git explorer
impact: Direct and group chat workspace panels now show live Git decorations and file diffs while keeping file previews inside the Explorer layout.
---

- Adds read-only workspace Git status and per-file diff endpoints without changing persistence or database schemas.
- Shows files and aggregate directory decorations in the workspace tree for both direct and group chat.
- Opens changed text files in a read-only diff before editing, falls back to file content when clean, and keeps image and document previews inside the right-hand content pane.
