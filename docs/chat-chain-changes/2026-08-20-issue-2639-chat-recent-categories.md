---
date: 2026-08-20
pr: 2642
feature: Single-chat recent category presentation
impact: The single-chat sidebar preserves the Recent group collapse state and labels every recent session with its localized category, including an explicit Uncategorized tag only after category loading succeeds; pinned and category-group rows remain untagged, and load failures remain explicit.
---

Issue #2639 changes only the single-chat session browser presentation. It does
not change message execution, session persistence, profile isolation, or the
underlying category API.
