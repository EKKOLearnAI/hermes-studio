---
date: 2026-08-11
pr: pending
feature: Issue #2482 durable handoff contract spike
impact: Design-only concentrated rework; no production integration is included.
---

Issue #2482 Stage A now defines the complete Local/Remote durable handoff
contract: persistent Source chain identity bound to the independent Target
inbox and authenticated peer, a two-phase claim/invocation protocol with
explicit crash recovery, authenticated cross-database cancellation, auditable
replacement/deletion lineage, and real terminal message publication in the
same Target transaction as `completed`.

The Source attempt is the sole Source receipt fact; the outbox no longer has a
second receipt copy. Local and Remote share the same state/version/error
semantics, while opaque random receipt values may differ. R1–R12 now include
chain/auth conflicts, post-invocation deletion/crash, and full message
publication evidence. Stage B, production code, PR, packaging, release,
installation, and deployment remain prohibited until independent
`DESIGN_PASS`.
