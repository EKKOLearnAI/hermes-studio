---
date: 2026-07-12
commit: pending
feature: Server-owned provider credential identity
impact: New and resumed scoped coding-agent sessions now use server-resolved provider credentials and client-side credential-presence signals instead of receiving stored API keys; message transport, persistence, queueing, and global-agent behavior are unchanged.
---

Stored provider secrets are no longer copied into available-model or config responses. The new-chat and continuation paths pass only an explicitly entered request credential, while the server hydrates matching stored credentials from the request-scoped profile and rejects endpoint or protocol mismatches.
