---
date: 2026-08-07
pr: pending
feature: Return to Agent link after login
impact: First-time Agent handoff users return to the authorization page instead of the default chat page.
---

The login route and login form now share the same validated redirect resolver.
An Agent handoff that requires authentication preserves the complete
`/group-chat-link` path and query parameters through login. Direct logins
without a redirect continue to open `/hermes/chat`.
