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
- Delivers group-chat approval events to authorized managers even when they have not joined the source Room, and permits direct responses without changing the active Room. In deployments without user authentication, the socket must already have a persisted membership in that Room; absence of `authUser` never grants global management authority.
- Subscribes to existing Workflow runtime status events and exposes approve/reject actions for nodes in `pending_approval`.
- Keeps unresolved responses pending and removes notifications when authoritative runtime state resolves them.
- Keys Group Chat approvals by Room plus approval ID so concurrent same-ID requests cannot overwrite or resolve each other.
- Publishes Workflow's authoritative pending approval locators, including the exact `executionId`, instead of inferring the waiter from node-session history.
- Uses an authenticated Profile-scoped Direct Chat audience so inactive Sessions receive approval/clarify lifecycle events without subscribing to every Session room.

Closes #2403.
