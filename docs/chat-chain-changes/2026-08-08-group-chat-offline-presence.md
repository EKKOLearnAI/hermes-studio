---
date: 2026-08-08
pr: 2423
feature: Group chat offline presence and remote Agent revocation consistency
impact: Human members and Agents remain visible but appear muted while temporarily offline; rotating a room invite code preserves existing remote Agent connections, while explicitly revoked connectors remove their active room Agent registration atomically.
---

Group chat member payloads now derive `online` or `offline` presence from the
room's Socket.IO runtime state. The avatar rail renders offline humans and
Agents in grayscale while retaining their persisted room entries for normal
reconnection.

Invite-code rotation remains limited to future invitation acceptance and does
not revoke, replace, or remove existing remote Agent connectors. A focused
route test locks this behavior in place.

Explicit connector revocation now marks the associated remote room Agent as
removed in the same database transaction. Startup reconciliation also repairs
legacy rows where a connector was already revoked but its Agent remained
visible. The Agent owner's service drops a persisted outbound link only when
the cloud confirms that its credential or registration is permanently invalid;
temporary Socket or network failures keep the link available for reconnection.
When the connector is online, revocation is also pushed over its Relay Socket
so the remote service stops reconnecting and removes the local link immediately.
Ordinary remote-server outages retain the existing one-to-thirty-second Socket.IO
reconnection backoff.

Outbound Agent links now live at
`HERMES_WEB_UI_HOME/group-chat/group-chat-agent-links.json`. On first access,
an existing root-level `group-chat-agent-links.json` is migrated to the new
location before the legacy file is removed.
