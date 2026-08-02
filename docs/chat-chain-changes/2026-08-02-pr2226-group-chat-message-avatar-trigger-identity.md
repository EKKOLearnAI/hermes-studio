---
date: 2026-08-02
pr: 2226
commit: pending
feature: Group Chat message-avatar trigger identity
impact: Tracks the exact message avatar that opened participant quick settings so repeated messages from one participant do not all expose aria-expanded=true. The event still carries the stable participant ID for Room-scoped settings and structured Mention behavior; participant persistence, Session identity, runtime dispatch, and next-run semantics are unchanged.
---

- Adds the triggering message ID to the existing message-avatar event without changing participant identity or persistence keys.
- Keeps only the clicked message avatar expanded when the same participant has multiple visible messages.
- Adds browser regression coverage for duplicate participant messages and resize-close lifecycle behavior.
