---
date: 2026-08-20
pr: pending
feature: Single-chat recent category presentation
impact: The single-chat sidebar now preserves the Recent group collapse state, labels recent sessions with their current category, and prevents no-op category moves while surfacing category load failures.
---

Issue #2639 changes only the single-chat session browser presentation. It does
not change message execution, session persistence, profile isolation, or the
underlying category API.
