---
date: 2026-07-14
pr: pending
feature: First-screen bundle splitting
impact: The app loads only startup code and the active locale before mounting, while heavy Markdown, Mermaid, editor, sidebar, pet, and inactive locale code stays lazy.
---

The production build now preserves route and dynamic-import boundaries instead
of forcing every dependency into shared vendor chunks. Markdown rendering loads
only when it is used while retaining the full syntax-highlighting catalog,
locale messages load on demand, and hashed build assets receive immutable cache
headers. The existing logo is unchanged.
