---
date: 2026-08-26
feature: studio-session-ownership
impact: Single-chat session routes and controllers are now owned by Studio; legacy URLs and imports remain compatible, while Hermes history and Coding Agent runtime actions are injected without behavior changes.
pr: pending
---

# Studio session ownership

The session HTTP controller and route moved into the Studio module because they
coordinate shared single-chat persistence, workspace files, usage, import and
export, and settings across Agent runtimes. Hermes state database and CLI calls,
bridge model updates, and Coding Agent cancellation still use their original
implementations through an adapter installed by the bootstrap composition root.
All `/api/hermes/sessions/*` routes, ordering, response shapes, and compatibility
imports are preserved.
