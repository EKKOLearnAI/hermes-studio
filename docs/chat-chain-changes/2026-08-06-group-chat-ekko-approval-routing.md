---
date: 2026-08-06
pr: pending
feature: Group Chat Ekko Agent approval routing
impact: Group Chat approval responses now resume the Ekko Agent session that requested them while Hermes Agent approvals continue through the Agent Bridge; the Group Chat UI no longer offers run-scoped session approval.
---

The Group Chat server records the validated room, Agent name, and runtime
session for each pending approval. Manager responses are bound to that room and
session, routed to the Ekko approval broker when it owns the request, and fall
back to the Hermes Agent Bridge otherwise.

Pending routes are removed when the approval resolves or the room runtime is
cleared or deleted. This also prevents a manager in another room from resolving
an approval by reusing its identifier.

Because Group Chat creates a fresh runtime session for every Agent run, the
session-level choice would not carry over to the next message. The Group Chat
approval panel therefore exposes one-time and permanent approval only, while
single-chat approval choices remain unchanged.
