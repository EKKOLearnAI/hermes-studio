---
date: 2026-08-08
issue: 2418
pr: pending
feature: persistent invited group-room memberships
touched: group-chat shared invitation membership
impact: Authenticated invite acceptance now creates a durable account member with an explicit invite source. The unified list exposes only a server-authoritative shared access type for that source; anonymous invite guests remain temporary.
---

Authenticated users can accept a current room invite through the protected
acceptance endpoint. This persists the existing room-member relationship with
`membershipSource=invite`, so access survives browser changes and invitation
code rotation. The room list chooses one source per room with the fixed
`owned > managed > shared` precedence and returns the resulting `accessType`.

Invite members can leave through the protected membership endpoint. The path
uses the existing live-member removal and remote-agent cleanup mechanism, so
Socket.IO room access, member-owned remote Agents, and attachment authorization
are revoked together. Owner removal continues to use the existing member
removal endpoint.
