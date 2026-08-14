---
date: 2026-08-14
pr: pending
feature: Group Chat speech input and authoritative execution queue
impact: Group Chat reuses the existing speech-to-text pipeline and exposes queued Agent work that safely converges across clients and can be cancelled before execution.
---

Group Chat composers now share the Browser, backend, and local speech-to-text
state machine used by direct chat. Transcripts are staged in the editable
composer and are never sent automatically.

Each mentioned Agent invocation is durably queued by the server with stable
ordering and requester identity. Room members receive the authoritative queue
on join and through live updates. Only the requesting member can cancel work
that has not started; cancellation does not remove the originating user
message, and the server atomically resolves cancellation-versus-start races.
