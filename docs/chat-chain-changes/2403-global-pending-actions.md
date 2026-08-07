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
- Delivers group-chat approval events to authorized managers even when they have not joined the source Room. In deployments without user authentication, off-Room global delivery and response are disabled because client-declared identities are not trusted; an in-context human must have joined the Room before managing its approval. Notification fanout also tolerates reduced Socket.IO test/runtime adapters that do not expose the namespace socket registry.
- Subscribes to existing Workflow runtime status events and exposes approve/reject actions for nodes in `pending_approval`; a second concurrent Run of the same Workflow is rejected so it cannot hide the first Run's pending approval.
- Keeps unresolved responses pending and removes notifications when authoritative runtime state resolves them; stale clarification responses do not erase replay state.
- Validates Direct Chat resume, abort, queue cancellation, approval, and clarification targets against the socket's authorized Profile before touching Session state or the Agent Bridge.
- Keys Group Chat approvals by Room plus approval ID so concurrent same-ID requests cannot overwrite or resolve each other.
- Publishes Workflow's authoritative pending approval locators, including the exact `executionId`, instead of inferring the waiter from node-session history.
- Uses an authenticated Profile-scoped Direct Chat audience so inactive Sessions receive approval/clarify lifecycle events without subscribing to every Session room.
- Adds an independent persisted `approval_bell` display setting. When enabled, every newly received authoritative approval or clarification key plays the existing short Web Audio tone once per reactive batch in each connected client, including when that client is currently viewing the source Session or Room. In-context cards still suppress only the duplicate global notification UI, not the sound. Restored pending actions, duplicate events, re-renders, and re-entry of an already announced key stay silent. Playback failure never blocks the notification or in-context action.

Closes #2403.
