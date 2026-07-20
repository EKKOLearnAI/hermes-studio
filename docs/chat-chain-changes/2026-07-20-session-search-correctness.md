---
date: 2026-07-20
pr: 2145
feature: Session search correctness
impact: Session search matches visible text around Markdown formatting and ranks eligible Coding Agent sessions before applying the result limit.
---

Search visibility constraints for source, Profile access, archived sessions, and
pending deletion are applied before result limiting. Exact title matches rank
ahead of partial title, preview, message-content, and tool-name matches.
