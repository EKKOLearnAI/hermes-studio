---
date: 2026-08-08
commit: pending
feature: Group Chat Agent-owner approval routing
impact: Group Chat approvals are visible and actionable only to the member who owns the requesting Agent, with pending approvals restored when that owner reconnects.
---

## Group Chat Agent-owner approvals

- Binds each pending approval route to the requesting Agent's persisted owner.
- Uses `ownerMemberId` for remotely linked guest Agents and the Room owner for server-hosted Agents.
- Sends requested and resolved approval events only to that owner and rejects responses from other Room managers, members, and administrators.
- Restores all still-pending approvals for an authenticated Agent owner when the Group Chat socket reconnects, even when the owner has not re-entered the source Room.
- Restores invite-member approvals through the existing Room join snapshot because unauthenticated off-Room identities are not trusted.
- Allows a non-manager Agent owner to use the in-Room approval card; the server remains the authoritative response gate.

Clarification prompts keep their existing Room-manager routing and are not changed by this update.
