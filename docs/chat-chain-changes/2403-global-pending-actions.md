---
date: 2026-08-07
commit: pending
feature: Global direct handling for existing approval prompts
impact: Existing direct-chat approval and clarify prompts, group-chat approvals, and workflow node approvals are now surfaced globally and can be handled without switching away from the current page.
---

## Global pending actions

- Mounts one application-level Naive UI notification host for existing pending approval and clarify interactions.
- Reuses the existing authoritative response paths instead of creating a generic notification API.
- Keeps direct-chat in-context cards while allowing an inactive Session request to be handled globally.
- Delivers group-chat approval events to authorized managers even when they have not joined the source Room, and permits direct responses without changing the active Room.
- Subscribes to existing Workflow runtime status events and exposes approve/reject actions for nodes in `pending_approval`.
- Keeps unresolved responses pending and removes notifications when authoritative runtime state resolves them.

Closes #2403.
