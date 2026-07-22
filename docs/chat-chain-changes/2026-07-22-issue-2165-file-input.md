---
date: 2026-07-22
pr: 2175
feature: Clipboard and workspace file attachments
impact: Single and group chats can attach non-image clipboard files and add workspace files to the active composer from the file context menu.
---

Clipboard files continue through the existing attachment upload and content-block
pipeline. Workspace files are read through the existing authenticated session or
room content endpoint and added to the composer without sending automatically.
