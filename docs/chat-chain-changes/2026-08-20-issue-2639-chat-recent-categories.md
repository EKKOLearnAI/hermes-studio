---
date: 2026-08-20
pr: 2642
feature: Single-chat recent category presentation
impact: The single-chat sidebar preserves the Recent group collapse state, lets users hide the entire Recent shortcut group through a browser-local Session setting without losing its saved count, and labels every visible recent session with its localized category; pinned and category-group rows remain untagged, and load failures remain explicit.
---

Issue #2639 changes only the single-chat session browser presentation and its
browser-local preferences. Hiding Recent leaves the category, pinned, archived,
and session data unchanged. It does not change message execution, session
persistence, profile isolation, or the underlying category API.
