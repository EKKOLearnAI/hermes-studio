---
date: 2026-08-11
pr: pending
feature: Issue #2488 formal Local/Remote durable handoff protocol model
impact: Adds a pure executable reference model and protocol evidence contract; no production routes, services, relay, schema, UI, or runtime behavior changes.
---

The Stage A model gives Source and Target independent durable stores implementing
the same authenticated `admit`, `getStatus`, and `cancel` contract.
Authentication binds the principal, capability scope, and complete request
digest. Source `cancel_pending` remains retryable until an authenticated
Target confirmation is reconciled as `cancelled` or `failed_manual`; stale
admission callbacks cannot clear that intent.

Target completion is only valid when a committed invocation marker, real Agent
message row, content digest, publication row, and terminal audit event are
present in the same Target model transaction. A Target restart before the
marker returns a claim to `admitted`; a restart after the marker without
publication is `failed_manual` and cannot be automatically re-run. Source and
Target each have durable audit events, and replacement creates explicit
authorized lineage from the failed attempt. Status proofs bind the complete
response and ordered audit evidence; tampered or expired responses are
rejected.

Local and Remote scenarios execute the same model. This is a design-only
artifact for Issue #2488 and is not production integration.
