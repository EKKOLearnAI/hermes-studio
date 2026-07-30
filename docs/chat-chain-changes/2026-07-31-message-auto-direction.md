---
date: 2026-07-31
pr: pending
feature: Message text finds its own direction
impact: Every rendered message block, the composer, and conversation titles in the list carry dir="auto", so a right-to-left message reads correctly while the interface stays in any locale, and a mixed conversation renders each block on its own terms; code blocks and inline code are pinned left-to-right so a snippet inside a right-to-left sentence is never mirrored.
---
