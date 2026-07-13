---
date: 2026-07-13
pr: pending
feature: Markdown local-file download filenames
impact: Local Markdown file links keep the target file extension when the visible label has no suffix.
---

Markdown-rendered local file cards now infer the download filename from the
target path when the link label is a human-readable name without a conventional
extension. Explicit labels that already include an extension remain preserved.
