---
date: 2026-08-14
pr: 2555
feature: Group Chat speech input and authoritative execution queue
impact: Group Chat reuses the existing speech-to-text pipeline and exposes queued Agent work that safely converges across clients and can be cancelled before execution.
---

Group Chat composers now share the Browser, backend, and local speech-to-text
state machine used by direct chat. Transcripts are staged in the editable
composer and are never sent automatically.

Each mentioned Agent invocation is durably queued by the server with stable
ordering and requester identity. FIFO execution is isolated by Room and target
Agent, so one Agent processes one task at a time while different Agents in the
same Room can run concurrently. Room members receive the authoritative queue
on join and through live updates. The Group Chat queue uses the same floating
message-queue component as direct chat while retaining the target Agent label.
Retraction requires a private,
browser-held capability whose hash is bound to the queued work and omitted
from Room snapshots, so a member cannot gain cancellation authority by
spoofing the displayed requester identity. If every Agent invocation for the
originating message is still queued, the server atomically cancels all of them
and retracts that message from durable Room history. Any started target rejects
the whole operation, and the server atomically resolves retraction-versus-start
races.
